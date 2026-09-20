---
name: serve
description: Serve a prototype at its public URL — provision its tunnel, start the dev server and connector under supervision, verify end to end, and recover when something is down. Use when the user wants to share/see a prototype online, when a prototype's public URL stopped working, or after create-prototype finishes.
---

# Serve

One verb: after it, the prototype is reachable at its public URL and
stays reachable — the dev server and the tunnel connector run detached
under `tools/supervise.mjs`, surviving this session. Everything reads
`~/.proto/config.json` (the app origin + credential; run setup if it's
missing) and the workspace's `public/prototype.json` (the port).

## Start

1. **Provision the tunnel** (idempotent; reuses an existing tunnel for
   the slug):

   ```
   POST <app>/api/tunnels   Authorization: Bearer <auth.secret>
   { "slug": "<slug>", "port": <port from prototype.json> }
   ```

   Returns `hostname` (the public address) and `connectorToken` (runs
   exactly this one tunnel, nothing else). A 401 means the credential
   in config.json is stale — back to setup's auth step.

2. **Write the run spec** at `~/.proto/<project>/run/<slug>/spec.json`
   (this dir, not the workspace — the workspace stays naked):

   ```jsonc
   {
     "name": "<project>/<slug>",
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

3. **Start**: `node tools/supervise.mjs start ~/.proto/<project>/run/<slug>`.
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

5. **Register the prototype** so it appears in the user's gallery:

   ```
   POST <app>/api/prototypes   Authorization: Bearer <auth.secret>
   { "project": "<project>", "slug": "<slug>", "title": "<title>",
     "owner": "<config.json account.user>" }
   ```

   Upserts on (project, slug) — re-registering after a title change is
   correct and expected. A 400 means a bad slug or empty title; a 404
   means the owner isn't a known user (check `account.user` in
   config.json); a 401 is the same stale-credential case as tunnels.

6. **Report**: the public URL, the Frame URL (`<app>/p/<slug>`), and
   where the run lives.

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
`-p` watch caps and re-arming, session resume — are recorded with
their verification evidence in `docs/claude-code-mechanics.md`.

Once per **project** (not per prototype), the site can start agent work
on this laptop through the courier daemon (`tools/courier.mjs`). Set it
up like one more supervised run:

1. Pick a free local port for the daemon; generate a command secret
   (`openssl rand -hex 24`).
2. Provision its tunnel with the same call as step 1, slug
   **`agent-<project>`**, the daemon's port.
3. Write `~/.proto/<project>/run/courier/`:
   - `courier.json` — `{ project, projectDir, port, secret, run }`
     (see the header of `tools/courier.mjs`; the `run` block is the
     headless-run command template — the spawned command line is
     config, not code). `chmod 600`.
   - `spec.json` — two processes: the daemon
     (`node <kit>/tools/courier.mjs <run-dir>`) and its `cloudflared`
     with the `agent-<project>` connector token.
4. `supervise.mjs start` it, then verify: a `{"status": true}` POST to
   `127.0.0.1:<port>` with `Authorization: Bearer <secret>` answers
   with runs + serving health; the same POST against the public
   `agent-<project>` hostname answers once the edge settles.
5. Give the site the command secret (how it's exchanged is the
   account-link's concern — today, tell the user to paste it where the
   site asks).

Commands are enumerated (`run` / `status` / `restart-serving`), acked
on receipt, one at a time per project with the rest queued. Every
`run` is delivered to **one persistent project agent** — a single
Claude Code session whose ID the daemon captures on the first run and
resumes ever after (`session.json` in the run dir). That gives the
agent continuity across commands, lets it spawn its own subagents, and
lets the user attach to the same conversation from their terminal:
`claude --resume <sessionId>`. A resumed run that dies without
producing events is treated as a broken session: the break is recorded,
the command retries once on a fresh session, the queue moves on.

The run instruction currently references the totypes MCP server by
template; until that server ships, wire a stub instruction in
`courier.json` for testing. No boot persistence by decision (MAA-130):
after a reboot, the site's Offline recovery prompt is the answer.

## Stop / teardown

`node tools/supervise.mjs stop <run-dir>` stops serving; the tunnel
and DNS record stay provisioned (harmless, instantly reusable). Full
teardown — only when the user asks to remove the prototype:
`DELETE <app>/api/tunnels {"slug": …}` with the same auth, then
delete the run dir.
