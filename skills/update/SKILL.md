---
name: update
description: >-
  Update Proto on this laptop to the latest version, and repair what the
  update leaves behind. Installs the newest plugin for the coding agent you
  are running in, then brings every codebase's runs up to what the new
  version expects, restarting them as needed. Use when the user asks to
  update Proto or get the latest version, when a Proto skill behaves as an
  older version did, or on its own to repair the runs after pulling the kit
  by hand.
---

# Update

Two halves. The **plugin** is the copy of the kit this laptop runs;
updating it is one command per harness and nothing else. The **runs**
are what the old version left behind under `~/.proto/`: a run created
by an older kit keeps the shape it was created with, because nothing
rewrites a run spec that already exists. The second half is the one
people feel: serving processes keep their old kit paths until the specs
are repaired. Retired command-delivery runs must never be restarted.

The halves are separable and often used apart. Somebody who pulled the
kit by hand wants the repair alone: skip to "Repair without updating".

All `<kit>/tools/…` paths resolve from the kit root: prefer the
installed host's `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT` or
`CURSOR_PLUGIN_ROOT`, otherwise the root above this skill's `skills/`
directory.

## What version this is

Read it before and after, so the report can say what moved:

- **Claude Code**: `claude plugin list --json` → the `proto@proto-kit`
  entry's `version` and `installPath`. The version is the marketplace
  commit this copy came from, because the Claude manifest carries no
  version of its own.
- **Codex**: `codex plugin list --json -m proto-kit` gives the version and
  source. Resolve the installed root from the installation result and verify
  its manifest; do not assume a cache path.
- **Cursor**: a local folder install is a checkout, so
  `git -C ~/.cursor/plugins/local/proto rev-parse --short HEAD`. A
  Customize-panel install has no version to read from a command; say
  so rather than guessing.
- **A bare checkout** (no plugin installed, the kit run from a clone):
  `git -C <kit> rev-parse --short HEAD`.

## Update the plugin

One command per harness. They are the same words the setup document
carries as `install.<harness>.update`; when you have a setup document
in hand, prefer its copy.

- **Claude Code**:
  `claude plugin marketplace update proto-kit && claude plugin update proto@proto-kit`.
  The new copy installs beside the old one under a new path; run the
  rest of this skill from the new copy (below).
- **Codex**: inspect `codex plugin marketplace list --json` first. Preserve a
  local marketplace and run only `codex plugin add proto@proto-kit`; never pull
  or replace that checkout. For a Git marketplace, run
  `codex plugin marketplace upgrade proto-kit && codex plugin add proto@proto-kit`.
  Resolve the actual installed root from the result.
- **Cursor**: there is no update command at all, and which half of the
  sentence applies depends on how the plugin was installed. A **local
  folder**: `git -C ~/.cursor/plugins/local/proto pull --ff-only`. A
  **Customize-panel** install: only the user can refresh it, in that
  panel, so ask them to and wait; a marketplace with auto refresh has
  already done it. Either way they then run **Developer: Reload
  Window** from the command palette so Cursor loads the new copy. The
  chat survives the reload.
- **A bare checkout**: `git -C <kit> pull --ff-only`. There is nothing
  to install; the next session reads the new files.

If the plugin is not installed at all, this is not an update: run the
setup skill instead, which installs it.

**Then re-read this skill from the new copy before going on**, the way
the setup skill does: the text you are following is the old version's,
and the repair below is defined by the new one. Find the new copy with
the version commands above, and run the repair from it.

## Retire legacy command delivery

All agents now run work in the active conversation. There is no listen skill,
experimental feature flag, or automatic website delivery.

Run `node <kit>/tools/retire-legacy-runs.mjs` for a read-only inventory. It is
not serving repair. If obsolete runs exist, report the exact proposed targets
and pass those explicit run-directory targets with `--apply` only when the
user authorized retiring them. Applying without named targets is refused. Never replay
queued commands. Uncertain process identity must be resolved, not guessed;
interactive agent sessions and serving runs are excluded. Report the archive
location and any blocked targets. Do not run retirement merely because a
library is missing or a build needs a reply.

On Codex, run `node <kit>/tools/codex-install.mjs` from the installed root to
synchronize the MCP path and supported roles and archive the obsolete kit-owned
listener role. Verify with `--check`; unrelated/custom roles are preserved.

## Move prototypes onto the rig from npm

A prototype scaffolded before the rig was published imports
`@proto/rig` or `@proto/rig-vue` and resolves it from a proto
checkout's source. The rig is `@proto-labs-inc/rig` on npm now; one call
moves every such workspace over, keeping everything the prototype is
made of:

```
node <kit>/tools/migrate-rig.mjs
```

For each workspace
it adds the rig to `package.json` at the version the kit pins, runs
`pnpm install`, renames the imports in `src/`, and drops the rig's
source paths from `tsconfig.json` and its aliases from
`vite.config.ts`. A workspace whose install fails is left exactly as it
was, and the line says why. A dev server that is up restarts itself when
its `vite.config.ts` changes, so nothing here needs a restart. If a
line asks for a hand edit, make it. Running it again changes nothing.

Do this before repairing the runs: the repair takes PROTO_PACKAGES out
of their specs, and a workspace still on the old aliases needs it until
it has moved.

## Repair the runs

One call, from the new copy of the kit:

```
node <kit>/tools/repair-runs.mjs --restart
```

It reads every run dir under `~/.proto/<codebase>/run/` and brings it
to this version: serving specs still pointing at a replaced kit, or carrying
obsolete package environment. It never provisions a tunnel or registers a
service. Legacy command-delivery runs are skipped and cannot be revived.
Running it twice changes nothing the second time.

`--restart` restarts every run that is up and whose spec changed, so
it picks up the new version straight away: a process this version
needs starts, and processes still running the replaced copy of the
kit come back on the new one. A run that is stopped stays stopped and
takes the change when it next starts. Perform only the requested scope of repair, and report any serving runs
restarted. A source-only update or migration review does not authorize restarts.

## Repair without updating

The repair stands alone. After pulling the kit by hand, or any time a
run looks like it was built by an older version:

```
node <kit>/tools/migrate-rig.mjs                       # first
node <kit>/tools/repair-runs.mjs --restart
node <kit>/tools/repair-runs.mjs <codebase> --restart  # one codebase, when that's all you mean
```

Nothing above it is required: it does not talk to the app, and it does
not care whether the plugin was updated a minute ago or a month ago.

## Report

Plain sentences, in this order:

- Which version this laptop moved from and to, named as the harness
  names them. On Cursor's Customize install, say instead that it was
  refreshed in the panel.
- Which prototypes moved onto the rig from npm, and anything that
  failed and why.

**When nothing needed doing, say so in one sentence** and stop: "Proto
is already on the latest version."

## What this does not touch

Ports, tunnels, connector tokens and the library scaffold belong to
`host-library.mjs` and the serve skill; a spec whose tunnel is
deprovisioned or whose port is wrong is a serve-skill problem and the
repair leaves it exactly as it found it. A run that is stopped stays
stopped: the session-start health line and `/proto:serve` are what
bring serving back, and starting something the user stopped is not an
update's business.
