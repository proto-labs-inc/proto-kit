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
`public/prototype.json` carries the port. All `tools/…` and
`<kit>/tools/…` paths resolve from the kit root:
`${CLAUDE_PLUGIN_ROOT}` when running as the installed proto plugin,
else the proto-kit checkout.

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

Once per **laptop and product** the site can start agent work here.
The product is the team's — many developers, each with their own
laptop and courier; **the courier is this laptop's**, identified by a
cloud-minted opaque `courierId`. No tunnel is ever named after the
product: tunnel slugs are per-laptop ids (`c-<courierId>`; the
library's tunnel likewise uses the cloud-minted `libraryId`). Laptop
paths stay keyed by the product id (`~/.proto/<productId>/`); the
courier and library ids live in the run dir. Three pieces, one
supervised run dir (`~/.proto/<productId>/run/courier/`):

- **The listener** (`tools/courier.mjs`) — the doorbell. Receives
  bearer-authed enumerated commands on a local port, validates, and
  appends each accepted command to `commands.jsonl`. It holds the
  port, so it runs under supervise, never under a Monitor watch.
- **The product agent** — the user's own interactive Claude Code
  session (terminal or the Claude Code desktop app) running the
  product-agent protocol; setup ends by telling them to keep it
  open. It watches the feed, acts on each command inline, commits
  `offset.json` after each, and heartbeats so the courier's status
  can report `agentListening`. Fallback: `tools/agent-launch.mjs`
  under the supervisor starts a headless session with the same
  protocol (capturing/resuming `session.json`) — recovery and
  nobody-at-the-keyboard mode, not the normal path.
- **The feed** (`commands.jsonl` + `offset.json`) — the durable,
  at-least-once buffer between them. It's what survives watch
  timeouts, agent restarts, and reboots.

Setup:

1. **Identity, once per laptop.** If the run dir has no `courierId`:
   `register_courier { product, account }` → `{ courierId,
   libraryId }` — both cloud-minted, both stored in `courier.json`.
   Never call this when a courierId already exists (a reinstall
   keeps its ids; one account with two laptops gets two couriers).
2. Pick a free local port for the listener; generate a command
   secret (`openssl rand -hex 24`).
3. Provision the tunnel: `provision_tunnel`, slug **`c-<courierId>`**,
   the listener's port.
4. **Endpoint**: `register_courier { courierId, host, secret,
   account }` — `host` the `c-<courierId>` hostname (a full URL is
   accepted for local dev couriers), `secret` from step 2. This
   call is repeatable, keyed on courierId: re-provisioned tunnel or
   rotated secret just overwrites. The user never sees or touches a
   credential.
5. Write `~/.proto/<productId>/run/courier/courier.json`
   (`chmod 600`) — `{ product, port, secret, courierId, libraryId,
   agent }`; the `agent` block is the fallback launcher's command
   template (see `tools/agent-launch.mjs`'s header).
6. `spec.json` — the listener
   (`node <kit>/tools/courier.mjs <run-dir>`) and `cloudflared` with
   the `c-<courierId>` connector token (plus the fallback agent
   launcher when running nobody-at-the-keyboard).
   `supervise.mjs start`.
7. Verify: a `{"status": true}` POST to `127.0.0.1:<port>` with
   `Authorization: Bearer <secret>` answers with `agentListening`
   and the line lands in `commands.jsonl`; the same POST works
   against the public `c-<courierId>` hostname once the edge
   settles.

**Heartbeat.** The listener beats `courier_heartbeat { courierId,
agentListening }` every ~30s (fail-soft; `agentListening` from the
feed watcher's local heartbeat). The site marks a courier offline
after 90s — three missed beats — and dispatches each brief to the
account's freshest listening courier; registered-but-not-listening
falls back to the copyable prompt with "your agent isn't running".

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
