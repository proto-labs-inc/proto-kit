---
name: update
description: >-
  Update Proto on this laptop to the latest version, and repair what the
  update leaves behind. Installs the newest plugin for the coding agent you
  are running in, then brings every codebase's run specs up to what the new
  version expects and says what needs restarting. Use when the user asks to
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
people feel. A version that adds a process to the courier's run spec
changes nothing for a laptop that already has a courier until
something repairs it, and until then the site's commands land in the
feed and stop there.

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
- **Codex**: `codex plugin list --json -m proto-kit` → `version`. The
  copy it runs from is
  `~/.codex/plugins/cache/proto-kit/proto/<version>/`.
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
  The new copy installs beside the old one under a new path. **This
  session keeps running the old copy until it restarts**, which the
  command says too; tell the user that plainly rather than implying
  the session is now new.
- **Codex**:
  `codex plugin marketplace upgrade proto-kit && codex plugin add proto@proto-kit`.
  Codex has no plugin update command: `upgrade` refreshes the
  marketplace snapshot and `add` installs that refreshed snapshot over
  the installed one. It is not a workaround, it is how Codex installs.
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

## Repair the runs

One call, from the new copy of the kit:

```
node <kit>/tools/repair-runs.mjs --check
```

It reads every run dir under `~/.proto/<codebase>/run/` and says what
does not match this version: a courier missing the Codex wake, a spec
still pointing at a copy of the kit the update replaced. Its header
names the rules it applies and, just as importantly, what it leaves
alone: it never provisions a tunnel, never registers anything, and
never invents a process it has no token for. Running it twice changes
nothing the second time.

Then:

1. **Show the user what `--check` printed** before writing anything.
   Its lines are already plain sentences; relay them, don't summarise
   them into "some runs need repair".
2. **Apply it**: the same command without `--check`. Rewriting a spec
   under a run that is up is safe, because the supervisor reads the
   spec when it starts.
3. **Restarting is the part you ask about.** A run that is up keeps
   the shape it started with until it restarts, and restarting takes
   something away from the person for a few seconds: a prototype's
   public address, the library's, or the site's command channel. The
   tool lists every run waiting on a restart and what each one
   interrupts, under two headings, and they are not the same problem:
   - **Waiting on a restart**: a process this version needs is not
     running there at all. A courier without the Codex wake takes no
     commands, and will not until it restarts.
   - **Still running an older copy of the kit**: its processes are up,
     but they were started from the copy this update replaced and go
     on running that version's code, including how it talks to the
     site. This one is invisible everywhere else, which is why it is
     worth reading out even though nothing looks wrong.

   Put both to the user in those words and wait for an answer. With a
   yes, run it again with `--restart`; with a no, leave them and say
   what stays stale until they do. Never restart a run because it is
   tidy to. Somebody is working in these sessions.
4. If it says a courier's own files don't say which agent it belongs
   to, run it again with `--harness claude`, `--harness codex` or
   `--harness cursor` for the agent you are running in. It reads the
   harness per courier, not per laptop, because one laptop can hold a
   Codex courier for one codebase and a Claude Code courier for
   another; the flag only answers for the ones nothing else does.

## Repair without updating

The repair stands alone. After pulling the kit by hand, or any time a
run looks like it was built by an older version:

```
node <kit>/tools/repair-runs.mjs --check      # then without --check
node <kit>/tools/repair-runs.mjs <codebase>   # one codebase, when that's all you mean
```

Nothing above it is required: it does not talk to the app, and it does
not care whether the plugin was updated a minute ago or a month ago.

## Report

Plain sentences, in this order:

- Which version this laptop moved from and to, named as the harness
  names them. On Cursor's Customize install, say instead that it was
  refreshed in the panel.
- Which codebases were repaired and what changed in each.
- **Which runs are still running a copy of the kit that this update
  replaced.** Name them even when everything looks healthy: their
  processes keep the old version's code, and its calls to the site,
  until they restart, and no health line, status report or log on this
  laptop ever mentions it.
- What is waiting on a restart, and that nothing was restarted without
  being asked.

**When nothing needed doing, say so in one sentence** and stop. An
already-current plugin and eight runs that already match is "Proto is
already on the latest version and every run matches it", not a list of
eight no-ops.

## What this does not touch

Ports, tunnels, connector tokens and the library scaffold belong to
`host-library.mjs` and the serve skill; a spec whose tunnel is
deprovisioned or whose port is wrong is a serve-skill problem and the
repair leaves it exactly as it found it. A run that is stopped stays
stopped: the session-start health line and `/proto:serve` are what
bring serving back, and starting something the user stopped is not an
update's business.
