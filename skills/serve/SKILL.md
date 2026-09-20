---
name: serve
description: Serve a prototype at its public URL — provision its tunnel, start the dev server and connector under supervision, verify end to end, and recover when something is down. Use when the user wants to share/see a prototype online, when a prototype's public URL stopped working, or after create-prototype finishes.
---

# Serve

One verb: after it, the prototype is reachable at its public URL and
stays reachable — the dev server and the tunnel connector run detached
under `tools/supervise.mjs`, surviving this session. Cloud actions go
through the **proto MCP server** (setup connects it; if its tools are
missing or `whoami` fails, run setup first). The workspace's
`public/prototype.json` carries the port.

## Start

1. **Provision the tunnel** (idempotent; reuses an existing tunnel for
   the slug): call the `provision_tunnel` MCP tool with
   `{ slug: "<slug>", port: <port from prototype.json> }`. It returns
   `hostname` (the public address) and `connectorToken` (runs exactly
   this one tunnel, nothing else). An auth failure means the MCP
   connection's credential is stale — back to setup.

2. **Write the run spec** at `~/.proto/<product>/run/<slug>/spec.json`
   (this dir, not the workspace — the workspace stays naked):

   ```jsonc
   {
     "name": "<product>/<slug>",
     "processes": [
       { "name": "dev", "cwd": "<workspace>", "command": ["pnpm", "dev"],
         "env": { "PROTO_TUNNEL": "1", "PROTO_PACKAGES": "<config.packages, pre-npm>" } },
       // dev command = the workspace's own package manager (its lockfile
       // tells you): ["npm", "run", "dev"], ["pnpm", "dev"], …
       { "name": "tunnel", "command": ["cloudflared", "tunnel", "run", "--token", "<connectorToken>"] }
     ]
   }
   ```

   `PROTO_TUNNEL=1` makes vite accept the public hostname and use wss
   HMR — without it the tunnel serves a blocked-host error. `chmod
   600 spec.json`; it holds the connector token.

3. **Start**: `node tools/supervise.mjs start ~/.proto/<product>/run/<slug>`.
   Children that die are restarted with backoff; `stop` and `status`
   take the same run dir.

4. **Verify end to end, in order** — each step isolates the next
   failure:
   - `http://localhost:<port>` serves the prototype (dev server up).
   - `http://localhost:<port>/prototype.json` returns the manifest
     (the Frame needs it).
   - `https://<hostname>` serves it publicly. Give the edge up to
     ~30s on a fresh tunnel (DNS + connector registration); retry,
     don't conclude.

5. **Report**: the public URL, the Frame URL (`<app>/p/<slug>`), and
   where the run lives. (Gallery registration is create-prototype's
   job, via the `register_prototype` MCP tool — it upserts, so
   re-registering there after a title change is the fix if the
   gallery shows a stale title.)

## Recovery

`node tools/supervise.mjs status <run-dir>` first — it names which
half is down. Then the log for that process in the run dir:

- **dev DOWN, restarts climbing** — read `dev.log`. Usual suspects:
  port taken by an abandoned server (`lsof -i :<port>`, kill it or
  fix the port in *both* `prototype.json` and `vite.config.ts`),
  missing `node_modules` (`pnpm install`), a workspace typecheck
  error introduced since.
- **tunnel DOWN or public URL dead with dev up** — read `tunnel.log`.
  `cloudflared` missing → install it; token rejected → the tunnel was
  deprovisioned, re-provision (step 1) and rewrite the spec; connected
  but 502 at the edge → the dev server isn't listening on the spec'd
  port.
- **Both up but the page is wrong** — the Frame reads
  `prototype.json` cross-origin; check it parses and its `port`
  matches vite's.
- **Doubt everything**: `stop`, then `start` — the spec is the whole
  truth of the run, and starting is idempotent.

## The courier (the website→laptop command channel)

Harness facts this design stands on — per-line Monitor wake-ups,
`-p` watch caps and re-arming, the lost-lines gap, session resume —
are recorded with their verification evidence in
`docs/claude-code-mechanics.md`.

Once per **product** (not per prototype), the site can start agent
work on this laptop. Three pieces, one supervised run dir
(`~/.proto/<product>/run/courier/`):

- **The listener** (`tools/courier.mjs`) — the doorbell. Receives
  bearer-authed enumerated commands on a local port, validates, and
  appends each accepted command to `commands.jsonl`. It holds the
  port, so it runs under supervise, never under a Monitor watch.
- **The product agent** — one persistent Claude Code session per
  product, launched by `tools/agent-launch.mjs` (which captures the
  session id into `session.json` and resumes it on every relaunch).
  It follows `skills/product-agent/`: watch the feed via Monitor on
  `tools/feed-tail.mjs`, act on each command inline, commit
  `offset.json` after each. The user can attach to the very same
  conversation: `claude --resume <sessionId>`.
- **The feed** (`commands.jsonl` + `offset.json`) — the durable,
  at-least-once buffer between them. It's what survives watch
  timeouts, agent restarts, and reboots.

Setup:

1. Pick a free local port for the listener; generate a command secret
   (`openssl rand -hex 24`).
2. Provision its tunnel with the same `provision_tunnel` tool as
   step 1, slug **`agent-<product>`**, the listener's port.
3. Write `~/.proto/<product>/run/courier/courier.json`
   (`chmod 600`) — `{ product, port, secret, agent }`; the `agent`
   block is the launcher's command template (see
   `tools/agent-launch.mjs`'s header). The spawned command line is
   config, not code.
4. `spec.json` — three processes: the listener
   (`node <kit>/tools/courier.mjs <run-dir>`), the agent launcher
   (`node <kit>/tools/agent-launch.mjs <run-dir>`), and `cloudflared`
   with the `agent-<product>` connector token. `supervise.mjs start`.
5. Verify: a `{"status": true}` POST to `127.0.0.1:<port>` with
   `Authorization: Bearer <secret>` acks 202 and the line lands in
   `commands.jsonl`; the agent's status report appears in
   `status.json`; the same POST works against the public
   `agent-<product>` hostname once the edge settles.
6. Give the site the command secret (how it's exchanged is the
   account-link's concern — today, tell the user to paste it where
   the site asks).

The proto MCP server carries the agent's cloud actions (registration,
tunnels, comments); command payloads arrive inline in the feed — MCP
prompts come later with the site's New-prototype dialog. No boot
persistence by decision (MAA-130): after a reboot, the site's Offline
recovery prompt is the answer.

## Stop / teardown

`node tools/supervise.mjs stop <run-dir>` stops serving; the tunnel
and DNS record stay provisioned (harmless, instantly reusable). Full
teardown — only when the user asks to remove the prototype: the
`delete_tunnel` MCP tool with the slug, then delete the run dir.
