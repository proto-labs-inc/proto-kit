---
name: serve
description: Put a prototype online. Registers it in your gallery, starts its dev server under supervision on this laptop, publishes a permanent snapshot, and recovers when something is down. Use when the user wants to share or see a prototype online, when a prototype stopped showing, or after create-prototype finishes.
---

# Serve

One verb: after it, the prototype runs on this laptop and its published
copy is on Proto. The maker sees the local dev server in the Proto
desktop app, with hot reload; everyone else sees the published copy,
which is published again at the end of every agent turn that changed the
workspace (`tools/auto-publish.mjs`, run by the kit's end-of-turn hook;
a workspace with an open build request is published by its skill instead,
and a starter's saved build only once step 2 switches it to the dev server).
The dev server runs detached under `tools/supervise.mjs`, surviving this
session for standalone plugin use. In the desktop app, open tabs own preview
servers: closing a tab pauses its chats and stops its server; quitting or
force-killing Proto stops all owned preview trees. Reopening Proto starts
servers for restored tabs. A desktop-owned run without an open tab refuses
startup. Reopen the tab instead of removing ownership records or starting a
replacement server. Cloud actions go through the **proto MCP server** (setup
connects it; if its tools are missing or `whoami` fails, run setup
first). The workspace's `public/prototype.json` carries the port. All
`tools/…` and `<kit>/tools/…` paths resolve from the kit root. Prefer the
installed plugin root exposed by the host (`PLUGIN_ROOT`,
`CLAUDE_PLUGIN_ROOT`, or `CURSOR_PLUGIN_ROOT`); otherwise use the root
above this skill's `skills/` directory, which is also the proto-kit
checkout root.

## Authorization

Invoking this skill from an explicit request to put a prototype online, or
from the create-prototype runbook, already authorizes registration,
starting the supervised dev server, and uploading the permanent snapshot.
Do not ask for a second permission for those expected steps. A host- or
tool-enforced confirmation still applies and must be presented when the
action reaches that boundary.

## Start

For an existing prototype, run `node <kit>/tools/update-rig.mjs <workspace>`
before serving or publishing. This prepares a sibling candidate, installs and
builds it, verifies every manifest state, and checks for concurrent source edits
before applying it. Stop agent edits and managed preview activity for this
workspace during the explicit migration. It is never background maintenance.
The tool refuses to replace a workspace whose preview port still answers. Use an
authorized external editing session with that prototype closed; never kill an
unrelated server or race a desktop preview owner. Browser verification here proves
startup and URL preservation; also verify real state/alternate interactions in the
Frame before publishing.
The previous workspace is retained at the returned `backup` path. Keep it until
publication and a check of the published prototype succeed. On failure, preserve
that backup and the previously published build; do not overwrite newer changes.
The tool never publishes. Current versions are unchanged. Stop on an upgrade
failure. Vue startup now awaits `protoRig(manifest)` before mounting; unknown
entrypoint shapes require manual repair in the candidate, not an unsafe rewrite.

1. **Register the prototype** first: `register_prototype { codebase,
   slug, title }`. The laptop token identifies the member and team. It
   upserts on (codebase, slug), so re-registering after a title change
   is correct. The row must exist before publishing. An authorization
   error means the laptop must be relinked through setup. Registering
   only records the prototype: a running build's brief stays open (its
   card stays in the gallery) until step 5 reports it done.

2. **Write the run spec** at `~/.proto/<codebase>/run/<slug>/spec.json`
   (this dir, not the workspace: the workspace stays naked):

   ```jsonc
   {
     "name": "<codebase>/<slug>",
     "processes": [
       { "name": "dev", "cwd": "<workspace>", "command": ["pnpm", "dev"] }
       // dev command = the workspace's own package manager (its lockfile
       // tells you): ["npm", "run", "dev"], ["pnpm", "dev"], …
     ]
   }
   ```

   For an unchanged indexed starter with a prepared `dist/`, the dev process
   command is `["node", "<kit>/tools/serve.mjs", "<workspace>/dist", "<port>"]`.
   This starts without installed dependencies. After editing the source, install
   from its lockfile and switch this command to the normal dev server; never keep
   serving the stale prepared dist after edits.

3. **Start**: `node tools/supervise.mjs start ~/.proto/<codebase>/run/<slug>`.
   Children that die are restarted with backoff; `stop` and `status`
   take the same run dir. Then check `http://localhost:<port>` serves
   the prototype and `http://localhost:<port>/prototype.json` returns
   the manifest (the Frame needs it).

4. **Publish** a permanent snapshot. For an unchanged indexed starter, upload
   the cloned `dist/` directly; skip dependency installation and compilation.
   For a new or edited page, build the workspace with its
   own build script (`pnpm build`; the templates configure relative
   asset paths, which a published build needs because it lives under
   a path). Then upload the output folder: `node tools/publish.mjs
   --kind prototype <workspace>` (`--dist <folder>` when the framework's output is
   not `dist/`). It uploads to a fresh path, sending only the files the
   last publish did not already have, and prints the published URL.
   That copy is what everyone but the maker sees.

For desktop-owned previews, call `ensure_preview` and pass its origin as
`--preview-url <url>` to publishing. It checks the served bytes against the
prepared dist and borrows that server for the capture without stopping it.
A stale or mismatched managed preview fails publication.

5. **Report**. When the workspace has a running brief, step 4's publish
   reports it done itself (that is what closes the build's card in the
   gallery; registering does not), so do not report done again. Then tell
   the user the Frame URL (`<app>/p/<slug>`), the
   published URL, and where the run lives. Tell the user plainly: in the
   Proto desktop app they see the prototype live from this laptop;
   everyone else sees the published copy, which follows each finished
   agent turn.

## The library

The codebase's design-system library (ADR 0003) is a Vite React app
at `~/.proto/<codebase>/library/` and is served the same way, with two
differences: there is nothing to register (the codebase's row already
exists) and the target has no slug. One call does all of it:

```
node tools/host-library.mjs <codebase>
```

It scaffolds the app from `template/library/` if the folder is not
there, refreshes the copy's app from the template, runs `pnpm install
--frozen-lockfile` if `node_modules` is missing, takes a free port for
this run (an up run keeps its own), records it in
`~/.proto/<codebase>/run/library/local.json` (the checks and the desktop
app read it), writes `~/.proto/<codebase>/run/library/spec.json` with
one process (`dev` = `["pnpm", "dev"]` in the library folder with
`PROTO_PORT=<port>`, which is what the library's `vite.config.ts`
binds), starts it under `supervise.mjs`, waits for
`http://localhost:<port>/manifest.json`, and prints `local:` and `run:`.
It is idempotent: setup runs it in the background at codebase creation,
the import runs it again first thing, and the app's recovery prompt
means run it once more.

Publish on request with `node tools/publish-library.mjs <codebase>`:
it builds the library folder (the build carries a copy of `public/`,
the import's data) and uploads `dist/`, one publish at a time. The
import runs the same command after every component lands and again
when it finishes.

## Recovery

`node tools/supervise.mjs status <run-dir>` first, then `dev.log` in
the run dir:

- **dev DOWN, restarts climbing**: usual suspects: port taken by an
  abandoned server (`lsof -i :<port>`, kill it or fix the port in
  *both* `prototype.json` and `vite.config.ts`), missing `node_modules`
  (`pnpm install`), a workspace typecheck error introduced since.
- **The published copy is behind**: read `<run-dir>/publish.log`. A
  failed build publishes nothing and the last good copy stays; fix the
  build, and the next turn's end publishes it, or run step 4 now.
- **Up but the page is wrong**: the Frame reads `prototype.json`
  cross-origin; check it parses and its `port` matches vite's.
- **Doubt everything**: `stop`, then `start`. The spec is the whole
  truth of the run, and starting is idempotent.

## Stop / teardown

`node tools/supervise.mjs stop <run-dir>` stops serving; the published
copy stays. Full teardown, only when the user asks to remove the
prototype: stop the run, then delete the run dir.

## Rig compatibility when copying starters

Cloning preserves the verified starter artifacts. If the independent copy pins
an older rig than the connected cloud app advertises, `screen-bundle.mjs` updates its rig dependencies,
installs them and rebuilds that copy before its normal smoke check. This is the
exception to the unchanged-copy no-install/no-build fast path. Copies already
on the current rig keep the prepared build fast path.
