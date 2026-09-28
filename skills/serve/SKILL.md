---
name: serve
description: Put a prototype online at its public address. Registers it in your gallery, provisions its tunnel, starts the dev server and connector under supervision, publishes a permanent snapshot, verifies end to end, and recovers when something is down. Use when the user wants to share or see a prototype online, when a prototype's public address stopped working, or after create-prototype finishes.
---

# Serve

One verb: after it, the prototype is reachable at its public URL and
stays reachable. The dev server and the tunnel connector run detached
under `tools/supervise.mjs`, surviving this session. Cloud actions go
through the **proto MCP server** (setup connects it; if its tools are
missing or `whoami` fails, run setup first). The workspace's
`public/prototype.json` carries the port. All `tools/…` and
`<kit>/tools/…` paths resolve from the kit root. Prefer the installed
plugin root exposed by the host (`PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, or
`CURSOR_PLUGIN_ROOT`); otherwise use the root above this skill's `skills/`
directory, which is also the proto-kit checkout root.

## Start

1. **Register the prototype** first: `register_prototype { codebase,
   slug, title }`. The laptop token identifies the member and team. It
   upserts on (codebase, slug), so re-registering after a title change
   is correct. The row must exist before the next step: the site
   stores the prototype's address on it. An authorization error means
   the laptop must be relinked through setup. Registering
   also flips the build's brief to done, closing the gallery's loading
   card; the tile waits for a heartbeat before it loads anything.

2. **Provision the tunnel** (idempotent; reuses an existing tunnel):
   call the `provision_tunnel` MCP tool with
   `{ kind: "prototype", codebase: "<codebase>", slug: "<slug>", port: <port from prototype.json> }`.
   The site chooses the address, stores it on the prototype's row, and
   returns it: `url` (the public address), `hostname` (its bare form)
   and `connectorToken` (runs exactly this one tunnel, nothing else).
   Never build the address yourself; read it from this answer. An
   "unknown prototype" error means step 1 was skipped; an auth failure
   means the MCP connection's credential is stale: back to setup.

3. **Write the run spec** at `~/.proto/<codebase>/run/<slug>/spec.json`
   (this dir, not the workspace: the workspace stays naked):

   ```jsonc
   {
     "name": "<codebase>/<slug>",
     "processes": [
       { "name": "dev", "cwd": "<workspace>", "command": ["pnpm", "dev"],
         "env": { "PROTO_TUNNEL": "1", "PROTO_PACKAGES": "<config.packages, pre-npm>" } },
       // dev command = the workspace's own package manager (its lockfile
       // tells you): ["npm", "run", "dev"], ["pnpm", "dev"], …
       { "name": "tunnel", "command": ["cloudflared", "tunnel", "run", "--token", "<connectorToken>"] },
       // Liveness: beats the app's `heartbeat` tool for
       // { kind: "prototype", codebase, slug } while dev and tunnel are
       // up, at the cadence the app answers with; its lifetime is the
       // serving lifetime, so stopping the run silences it and staleness
       // tells the Frame to use the published build. No "is live" flag
       // exists anywhere, and the beat says nothing about the tunnel: the
       // viewer's browser tries the address and finds out.
       { "name": "heartbeat", "command": ["node", "<kit>/tools/prototype-heartbeat.mjs", "--kind", "prototype", "<run-dir>", "<codebase>", "<slug>"] }
     ]
   }
   ```

   `PROTO_TUNNEL=1` makes vite accept the public hostname and use wss
   HMR: without it the tunnel serves a blocked-host error. `chmod
   600 spec.json`; it holds the connector token.

4. **Start**: `node tools/supervise.mjs start ~/.proto/<codebase>/run/<slug>`.
   Children that die are restarted with backoff; `stop` and `status`
   take the same run dir.

5. **Verify end to end, in order**, each step isolates the next
   failure:
   - `http://localhost:<port>` serves the prototype (dev server up).
   - `http://localhost:<port>/prototype.json` returns the manifest
     (the Frame needs it).
   - The `url` from step 2 serves it publicly. Check this **through
     Cloudflare's edge only**: `curl --resolve <hostname>:443:<edge
     ip> https://<hostname>/prototype.json`, with the ip from `dig
     @1.1.1.1 <hostname> A`. Give the edge up to ~30s on a fresh
     tunnel (connector registration); retry, don't conclude. Never
     use a plain `curl https://<hostname>` or open the hostname in a
     browser to check: that is a lookup through this laptop's
     resolver, and if it runs before the record has spread it is
     remembered as "does not exist" for thirty minutes, on this
     laptop and at the ISP, and the prototype looks dead long after
     it is up. The record can take a few minutes to be visible to
     ordinary resolvers; that is normal and not yours to wait for.
     (The site itself never loads the address until the row has one
     and a fresh heartbeat, so registering first is safe.)

   **Before you wait on the edge at all, ask cloudflared.** It writes
   its own verdict into `<run-dir>/tunnel.log` within about fifteen
   seconds of starting: `precheck complete hard_fail=true` means this
   network cannot carry a tunnel, and `Registered tunnel connection`
   means it can and has. `<kit>/tools/tunnel-state.mjs` is that reading
   as a module: `tunnelState(runDir)` answers `connecting`, `connected`
   or `blocked`, and the heartbeat and `host-library.mjs` both use it. On `blocked`, stop waiting and say this, once, in
   these words:

   > This network blocks the connection the tunnel needs (port 7844), so nothing here can go live on it. Publishing still works, and so does everything else this laptop sends to Proto; for a live view use a phone hotspot or another network.

   Then carry on: the dev server is up, the prototype publishes over
   443, and the Frame shows the published build. Do not stop, do not
   retry the edge, and do not restart anything when the network
   recovers: the site tries the address on every read, so it picks the
   live view back up on its own. If a brief is running,
   `report_progress {briefId, status: "failed"}` with that sentence as
   the message: the live view is what failed, and the sentence says
   what still works.

6. **Publish** a permanent snapshot. Build the workspace with its
   own build script (`pnpm build`; the templates configure relative
   asset paths, which a published build needs because it lives under
   a path). Then upload the output folder: `node tools/publish.mjs
   --kind prototype <workspace>` (`--dist <folder>` when the framework's output is
   not `dist/`). It uploads to a fresh path and prints the published
   URL. The Frame falls back to that URL when the laptop is gone, so
   viewers see the last checkpoint instead of nothing.

7. **Report**: the live URL (step 2's `url`), the published URL, the
   Frame URL (`<app>/p/<slug>`), and where the run lives. Tell the
   user plainly: the prototype is live while this laptop serves it,
   and falls back to the last published build when serving stops.

## The library

The codebase's design-system library (ADR 0003) is a Vite React app
at `~/.proto/<codebase>/library/` and is served the same way, with two
differences: there is nothing to register (the codebase's row already
exists) and the target has no slug. One call does all of it:

```
node tools/host-library.mjs <codebase>
```

It scaffolds the app from `template/library/` if the folder is not
there, refreshes the copy's `vite.config.ts` from the template, runs
`pnpm install --frozen-lockfile` if `node_modules` is
missing, takes a free port for this run, calls `provision_tunnel {
kind: "library", codebase, port }` with it (the site chooses the
address), writes `~/.proto/<codebase>/run/library/spec.json` with
three processes (`dev` = `["pnpm", "dev"]` in the library folder with
`PROTO_TUNNEL=1` and `PROTO_PORT=<port>`, which is what the library's
`vite.config.ts` binds; `tunnel` = cloudflared with the connector token;
`heartbeat` = `node <kit>/tools/prototype-heartbeat.mjs --kind library
<run-dir> <codebase>`), `chmod 600`, starts it under `supervise.mjs`,
waits for `http://localhost:<port>/manifest.json`, reads cloudflared's
own log for whether it reached Cloudflare, verifies the public address
through the edge with `--resolve` as step 5 above describes when it
did, and prints the public URL, the local URL, the run dir and
`tunnel: connected` or `tunnel: blocked`. Once the dev server answers
it succeeds: a blocked tunnel prints the sentence above and returns
`tunnel: blocked`, because the library is up locally and publishing
works regardless, and failing here was how an import came to extract
nothing at all.
It is idempotent: setup runs it in the background at codebase
creation, the import runs it again first thing and gets the address,
and the app's recovery prompt ("serve ~/.proto/<codebase>/library and
run its tunnel") means run it once more. A library run without a
tunnel process is a bug: the beat stays silent without one.

Publish on request with `node tools/publish-library.mjs <codebase>`:
it builds the library folder (the build carries a copy of `public/`,
the import's data) and uploads `dist/`, one publish at a time. The
import runs the same command after every component lands and again
when it finishes.

## Recovery

`node tools/supervise.mjs status <run-dir>` first: it names which
half is down. Then the log for that process in the run dir:

- **dev DOWN, restarts climbing**: read `dev.log`. Usual suspects:
  port taken by an abandoned server (`lsof -i :<port>`, kill it or
  fix the port in *both* `prototype.json` and `vite.config.ts`),
  missing `node_modules` (`pnpm install`), a workspace typecheck
  error introduced since.
- **tunnel DOWN or public URL dead with dev up**: read `tunnel.log`.
  `cloudflared` missing → install it; token rejected → the tunnel was
  deprovisioned, re-provision (step 2) and rewrite the spec; connected
  but 502 at the edge → the dev server isn't listening on the spec'd
  port.
- **tunnel "up" but the address answers Cloudflare 530, and
  `tunnel.log` says `precheck complete hard_fail=true`**: this network
  blocks the tunnel. Nothing on this laptop is broken and nothing here
  can fix it; `supervise status` says "up" because the cloudflared
  process is alive, which is not the same as connected. Say:

  > This network blocks the connection the tunnel needs (port 7844), so nothing here can go live on it. Publishing still works, and so does everything else this laptop sends to Proto; for a live view use a phone hotspot or another network.

  Leave the run up. When the laptop moves to a network that allows it,
  cloudflared registers a connection by itself and the next beat says
  so; nothing needs restarting.
- **Both up but the page is wrong**: the Frame reads
  `prototype.json` cross-origin; check it parses and its `port`
  matches vite's.
- **Doubt everything**: `stop`, then `start`. The spec is the whole
  truth of the run, and starting is idempotent.

## The courier (the website→laptop command channel)

Harness facts this design stands on, per-line Monitor wake-ups,
`-p` watch caps and re-arming, the lost-lines gap, session resume,
are recorded with their verification evidence in
`docs/harness-mechanics.md`.

Once per **laptop and codebase** the site can start agent work here.
The codebase is the team's: many developers, each with their own
laptop and courier; **the courier is this laptop's**, identified by a
cloud-minted opaque `courierId`. Tunnels are provisioned by target:
the courier's is `{ kind: "courier", courierId }`, one per laptop,
never named after the codebase; the library's is `{ kind: "library",
codebase }`, one per codebase (two laptops serving the same codebase's
library would contend for it, accepted for now). The site chooses and
stores every address; read it from the tool's answer, never build it.
Laptop paths stay keyed by the codebase id
(`~/.proto/<codebase>/`); the courier id lives in the run dir. Three pieces, one
supervised run dir (`~/.proto/<codebase>/run/courier/`):

- **The listener** (`tools/courier.mjs`): the doorbell. Receives
  bearer-authed enumerated commands on a local port, validates, and
  appends each accepted command to `commands.jsonl`. It holds the
  port, so it runs under supervise, never under a Monitor watch.
- **The session running the listen skill**: the user's own
  interactive session (a Claude Code terminal or desktop window, or a
  Codex window); setup ends by telling them to keep it open. It
  watches the feed, acts on each command inline, commits
  `offset.json` after each, and heartbeats so the courier's status
  can report `agentListening`. Fallback: `tools/agent-launch.mjs`
  under the supervisor starts a headless session with the same
  protocol (capturing/resuming `session.json`): recovery and
  nobody-at-the-keyboard mode, not the normal path.
- **The Codex wake** (`tools/feed-queue.mjs`, Codex only): nothing
  wakes an idle Codex session, so on Codex a supervised process does
  the waking. It watches the feed and queues each command into the
  session the person has open (`codex queue --thread <id>`, the
  daemon's own managed binary), which is why the work still happens in
  front of them. The thread id is `courier.json`'s `codexThread`,
  written by the listen skill through `tools/codex-thread.mjs`. On
  Codex this process owns `offset.json` and the heartbeat instead of
  the session. Claude Code doesn't need it: the Monitor tool wakes
  that session per line.
- **The feed** (`commands.jsonl` + `offset.json`): the durable,
  at-least-once buffer between them. It's what survives watch
  timeouts, agent restarts, and reboots.

Setup, run by the import skill while its units extract (it depends
only on the codebase id, so nothing waits on it):

1. **Identity, once per laptop.** If the run dir has no `courierId`:
   `register_courier { codebase }` → `{ courierId,
   libraryId }`: both cloud-minted, both stored in `courier.json`.
   Never call this when a courierId already exists (a reinstall
   keeps its ids; one member with two laptops gets two couriers).
2. Pick a free local port for the listener; generate a command
   secret (`openssl rand -hex 24`).
3. Provision the tunnel: `provision_tunnel { kind: "courier",
   courierId, port: <the listener's port> }`. The site chooses the
   courier's public address, stores it on the courier's row, and
   returns it as `hostname` with the `connectorToken`. Re-provisioning
   overwrites the stored address.
4. **Secret**: `register_courier { courierId, secret }`,
   `secret` from step 2. This call is repeatable, keyed on courierId:
   a rotated secret just overwrites. The user never sees or touches a
   credential.
5. Write `~/.proto/<codebase>/run/courier/courier.json`
   (`chmod 600`): `{ codebase, port, secret, courierId, libraryId,
   codebaseDir, agent }`; `codebaseDir` is the codebase checkout
   (`codebase.json`'s `source.path`), where the fallback session runs;
   the `agent` block is the fallback launcher's command template (see
   `tools/agent-launch.mjs`'s header; on Codex, `codexAgent`, see
   `tools/feed-drive.mjs`).
6. `spec.json`: the listener
   (`node <kit>/tools/courier.mjs <run-dir>`) and `cloudflared` with
   the courier's connector token from step 3 (plus the fallback agent
   launcher when running nobody-at-the-keyboard). **On Codex, add a
   third process** `codex-wake`, `node <kit>/tools/feed-queue.mjs
   <run-dir>`: without it nothing ever wakes the Codex session and
   commands simply pile up in the feed. It is harmless before a
   session has identified itself, and it is not part of a Claude Code
   or Cursor spec. `supervise.mjs start`.
7. Verify: a `{"status": true}` POST to `127.0.0.1:<port>` with
   `Authorization: Bearer <secret>` answers with `agentListening`
   and the line lands in `commands.jsonl`; the same POST works
   against the public hostname from step 3 once the edge settles.

**Heartbeat.** The listener beats the app's `heartbeat` tool for
`{ kind: "courier", courierId, agentListening }` at the cadence the app
answers with (fail-soft; `agentListening` from the feed watcher's local
heartbeat). It is the same tool a prototype's or the library's serving
run beats, with its own target. A courier whose beats have gone stale is
offline; the site dispatches each brief to the team's freshest listening
courier, and registered-but-not-listening falls back to the copyable
prompt with "your agent isn't running".

A beat never says anything about the tunnel's own state. The site
pushes commands through the courier's tunnel, so on a network that
blocks port 7844 the dispatch fails and the site says so from that
failure; the question disappears once the courier pulls its own work
over HTTPS.

The proto MCP server carries the agent's cloud actions (registration,
tunnels, comments); command payloads arrive inline in the feed: MCP
prompts come later with the site's New-prototype dialog. No boot
persistence by decision (MAA-130): after a reboot, the site's Offline
recovery prompt is the answer.

## Stop / teardown

`node tools/supervise.mjs stop <run-dir>` stops serving; the tunnel
and DNS record stay provisioned (harmless, instantly reusable). Full
teardown, only when the user asks to remove the prototype: the
`delete_tunnel` MCP tool with the same target provisioning took
(`{ kind: "prototype", codebase, slug }`), which also clears the
stored address, then delete the run dir.
