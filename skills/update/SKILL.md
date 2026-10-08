---
name: update
description: >-
  Check the installed Proto kit against the release version in a copied
  Proto prompt. Install the current GitHub release if an update is needed,
  then continue the original request. Use when a copied prompt asks for
  the Proto update skill.
---

# Check Proto before continuing a copied prompt

Follow one flow: read the prompt's required version, check the installed kit
locally, update if needed, then carry out the original request.

## 1. Check the installed version

Use the active plugin root as `<kit>`, from the host's plugin environment or
this skill's location. Do not choose an arbitrary copy from the cache. If the
root is unclear, use `codex plugin list --json -m proto-kit` or
`claude plugin list --json`; Cursor's folder install is at
`~/.cursor/plugins/local/proto`.

Read the required version from the copied prompt and run:

```sh
node <kit>/tools/check-plugin.cjs <kit> <prompt-version>
```

This script reads local files only:

- `current`: the installed release meets the prompt's version. Skip step 2 and
  continue the original request using this kit.
- `update_needed`: go to step 2.

The check compares with the prompt's version, not releases published after the
prompt was copied. If the prompt has no version, pass `unknown`. If this kit is
missing the checker, go to step 2. Missing or unverified installations also need
step 2.

## 2. Install the updated kit

Download and run the updater from GitHub's `release` branch. Replace `AGENT`
with `codex`, `claude` or `cursor` for the current host:

```sh
bash -c 'set -eu; proto_update_dir=$(mktemp -d); trap "rm -rf \"$proto_update_dir\"" EXIT; curl --retry 2 --fail --silent --show-error --location https://raw.githubusercontent.com/proto-labs-inc/proto-kit/refs/heads/release/tools/update-plugin.mjs -o "$proto_update_dir/update.mjs"; node "$proto_update_dir/update.mjs" --agent AGENT'
```

The script installs and verifies the GitHub release, switches old marketplace
registrations to that source, and prints the new installed root. It preserves
local source files and stops if a Cursor checkout has edits or divergent commits.

Use the host's permission process if network access or plugin-directory writes
are blocked. Retry the same command with permission; stop if permission is denied
or the permitted retry fails. Never fall back to main or local files. Local
installation requires an explicit user request for that operation.

## 3. Continue the original request

Require `status: verified` and `installedRoot` in the updater's output. An empty
successful process result does not prove the update ran.

Read the skill needed for the original task from that installed root. Reload
host tools if they still use the old copy, then continue the exact request the
user pasted. This version check does not migrate workspaces or restart serving
processes.
