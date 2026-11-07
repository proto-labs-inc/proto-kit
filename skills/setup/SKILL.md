---
name: setup
description: >-
  Install or update the Proto plugin, connect the proto MCP server, and recover
  this laptop's local Proto records. Laptops are linked and codebases connected
  by the Proto desktop app when the maker signs in and chooses a folder, not here.
---

# Setup

Setup installs and repairs the plugin and this laptop's local Proto records.
Linking the laptop and connecting a codebase happen in the Proto desktop app, which writes `~/.proto/<codebase>/codebase.json` itself; new
prototypes are built there as islands in the maker's own app, following
the brief Proto sends with each message.
It never starts a listener, binds a conversation, or waits for website commands.
Reject old courier-delivery envelopes rather than treating them as new user requests.

The **machine** scope is idempotent (config.json, prerequisites, the MCP
server). Re-running setup repairs; it never clobbers working state.

The user is often not an engineer. Two standing rules for the whole
flow: **failures are plain sentences**, never surface raw command
output, stack traces, or anything that reads as an error wall; and
**never send the user to tokens, SSH keys, or GitHub developer
settings**.

## When it runs

The user runs `/proto:setup` on Claude Code, `$setup` on Codex, or picks the
Proto setup skill from the chat's `/` menu on Cursor, or asks to set up or
repair Proto. Nothing needs pasting: the desktop app has already linked this
laptop and written its codebase records when the maker signed in and chose a
folder. Setup installs or updates the plugin, makes sure the proto MCP server
is registered, and repairs the local records below.

### Published kit version

App prompts carry `kitRelease` from the release registry. Before setup, compare
its version with the installed `.codex-plugin/plugin.json` (all harnesses).
Compare the 14-digit UTC suffix: equal or newer needs no update. For an older
release, follow the update skill, resolve the installed root and re-read setup
there, preserving this document and request. Local development marketplaces
and checkouts with uncommitted edits are exempt. Never claim an update worked
unless the resulting manifest meets the requested version. A missing release
record uses the update skill's normal marketplace check. Do not restart an
active host automatically; explain any required reload and preserve the request.

### Linking a laptop

The Proto desktop app links this laptop when the maker signs in and writes
its credential to `~/.proto/config.json` itself; it also writes each
connected codebase's `~/.proto/<codebase>/codebase.json`. There are no setup
documents or linking codes any more. If `whoami` says this laptop is not
linked, ask the maker to open the Proto app and sign in, then check again.

### Keep the plugin current

Use GitHub's generated `release` branch for normal installs and updates.
Local files require an explicit user request for this operation; an existing
local registration does not make local the default. Follow the source
selection and migration steps in `../update/SKILL.md` before updating.
A registration that names main or an unpinned GitHub source must use
release instead. Never fall back to main when release is unavailable.

For a fresh install:

- Codex: `codex plugin marketplace add proto-labs-inc/proto-kit --ref release && codex plugin add proto@proto-kit`.
- Claude: `claude plugin marketplace add proto-labs-inc/proto-kit#release && claude plugin install proto@proto-kit`.
- Cursor: `git clone --branch release https://github.com/proto-labs-inc/proto-kit ~/.cursor/plugins/local/proto`, then **Developer: Reload Window**.

For an existing installation, run the update skill's plugin steps and verify
the installed version. Re-read this setup skill from the new installed copy
before linking the laptop. Preserve local development folders and their edits.

### Prerequisites

`node` (≥ 20) and `pnpm` on PATH. Install what's missing with the
user's package manager; tell them what you installed. Everything this
laptop sends to Proto goes over ordinary HTTPS and works on any network.

### `~/.proto/config.json`

The laptop link, the one file every other skill and tool reads
for "who am I and where is the app". One credential per team: a
token is minted against one team, so a laptop that works in two
teams holds two, side by side.

```jsonc
{
  "schemaVersion": 3,
  "app": "https://…",              // the document's app
  "credentials": [                 // one per team, newest link last
    {
      "kind": "laptop-token",
      "secret": "…",
      "user": { "id": "<id>", "name": "<name>", "email": "…" },
      "team": { "id": "<id>", "name": "<name>" },
      "laptop": { "id": "<id>", "label": "<hostname>" },
      "linkedAt": "2026-09-28T…"
    }
  ],
  "createdAt": "2026-09-19T…"
}
```

The Proto desktop app writes this file with mode 600 when the maker signs in. It adds the new
credential beside the ones already there, replacing only a credential
for the same team, so linking a second team never costs the first.
A file written by an older kit (`schemaVersion: 2`, one credential
under `auth`) keeps working as it is and is read as a single
credential; the next link writes the shape above, carrying it over.

When setup started as a command with no prompt, ask the user to copy
the setup prompt from the Proto site and stop until they paste it.
Never search the disk for a credential: a `.env` file belonging to a
checkout is not this laptop's credential.

Every cloud call sends `Authorization: Bearer <secret>`, and the
server derives the member and team from that token. Which credential
is the codebase's: `~/.proto/<codebase>/codebase.json` records the
team that owns it, and the kit's tools and the MCP bridge pick by the
`codebase` the call names. A call for a codebase whose team this
laptop is not linked to is refused with a sentence naming that team,
and the fix is to paste that team's setup prompt — not to relink the
laptop. A call that names no codebase acts as the only credential, or
the most recently linked one, saying so on stderr.

### The proto MCP server

The `proto` MCP server is how every kit skill talks to Proto
(registration, publishing, source registry, comments). In Claude Code and
Cursor it ships as the kit's stdio bridge (`tools/mcp-stdio.mjs`), which
reads config.json, so once the desktop app has written the file the server
works with nothing else to add. The bridge announces its tools when
config.json appears; if they still do not show, the user toggles the
Proto MCP server off and on in Customize. Its tools may appear under a host-specific scoped name; this and the
other skills refer to them by bare tool name. The kit's plain tools
(supervisor, publisher) read the same config.json.

Running from a bare checkout instead, add the same bridge manually in
Claude Code: `claude mcp add proto -- node <kit>/tools/mcp-stdio.mjs`.
Never add it as an HTTP server with a fixed `Authorization` header: a
header written into a harness config pins the connection to one team
and goes stale the moment that token is revoked.

**On Codex**, run `node <kit>/tools/codex-install.mjs` from the installed
root. It synchronizes the supported roles and MCP bridge and archives only
recognizable obsolete Proto listener roles. It never starts a service. The
server entry is

```toml
[mcp_servers.proto]
command = "node"
args = ["<kit>/tools/mcp-stdio.mjs"]
```

Verify synchronization with `node <kit>/tools/codex-install.mjs --check`.
Do not merely copy a role glob: removed roles would remain installed.

Either way, confirm with the `whoami` tool: it reports the auth
mode, team, and grants. A connected server whose `whoami` fails means
the credential is stale: redo the auth step above.

## Codebase records

### `~/.proto/<codebase>/codebase.json`

The Proto desktop app writes this record when the codebase is connected;
kit tools read it to pick the codebase's team credential. Never assemble
or overwrite it yourself.

```jsonc
{
  "schemaVersion": 1,
  "codebase": "<id>",                   // the cloud-minted id
  "name": "acme-web",                  // display name; renamable, never a path
  "team": { "id": "<id>", "name": "<name>" },  // which credential this codebase uses
  "source": {
    "kind": "repository",
    "path": "/abs/path/to/acme-web",   // the checkout
    "remote": "git@github.com:acme/acme-web.git",
    "liveUrl": "https://…"             // where the codebase runs, if known
  },
  "createdAt": "2026-09-19T…"
}
```

### Migration: pre-rename homes

This concept was called "project", then "product", before
"codebase". If a home has `project.json` or `product.json`, repair
it in place: rename the file to `codebase.json` and its `"project"`
or `"product"` key to `"codebase"` (and a library `manifest.json` with either
old field). Leave retired command-delivery files to the explicit retirement
utility; do not migrate them into an active run. Nothing running is affected: supervisors and run-dir
specs never reference these files by those names, so migrate
without stopping anything.

## Verify

- `config.json` parses, and each `~/.proto/<codebase>/codebase.json` parses
  and names an existing `source.path`.
- The `whoami` MCP tool answers with the expected team and grants. When it
  says this laptop isn't linked, ask the maker to sign in to the Proto app.

Report what you installed or repaired in plain sentences, then anything you
skipped because it already existed.

## Handoff

Setup ends once the plugin is current and `whoami` answers. Copied prototypes
are edited from their chats in the Proto app with the edit-variant,
add-variants, create-variant-set and serve skills; new prototypes are forked
in the maker's own app and need nothing from setup.
