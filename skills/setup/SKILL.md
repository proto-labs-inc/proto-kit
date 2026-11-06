---
name: setup
description: >-
  Link this computer to Proto: install or update the plugin, link the laptop
  from a setup prompt copied from the Proto site, connect the proto MCP server,
  and reopen an existing copied prototype from its Edit prompt. Starts from
  "Set up Proto for" and continues in the active agent conversation. Also use
  when installing Proto or recovering its local connection records.
  Codebases are connected in the Proto desktop app, not here.
---

# Setup

Setup links this laptop to Proto and, from an Edit prompt, reopens an
existing copied prototype. Connecting a codebase happens in the Proto
desktop app, which writes `~/.proto/<codebase>/codebase.json` itself; new
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

## Two ways in

**As a command**: with the proto plugin installed, the user runs
`/proto:setup` on Claude Code, `$setup` on Codex, or picks the Proto
setup skill from the chat's `/` menu on Cursor (or just asks to set
up Proto, in the terminal, the Claude Code desktop app, the Codex
app, or Cursor's chat). Nothing was pasted, so ask for the one thing
setup can't derive: the setup prompt, copied from the Proto site (it carries the identity
and everything else below). One question, then proceed
exactly as below once they paste it.

**As the prompt**: pasted from the Proto site. Its first line is the sentence
the recognizer keys on; its last line is the complete JSON setup document:

```
Set up Proto for <name> (<id>) at <team>.
Follow the Proto setup data below.
{"instructions":"...","account":{"id":"...","name":"...","team":"..."},...}
```

A `, codebase <id>, prototype <slug>` suffix
is the **Edit prompt**, copied from a prototype's Frame by its creator
for their coding agent: see "Editing a prototype" at the
end. Everything else comes from the embedded document. Run the whole flow
without re-asking for anything the document already says.

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

### The setup document

Run `node <kit>/tools/link-laptop.mjs <app> <linkingCode> <account.id>`
exactly once, substituting those three values from the document. The helper
exchanges `linkingCode` for this laptop's token when needed, adds the token to
`~/.proto/config.json`, and prints the linked identity and what linking
changed. The code expires at `expiresAt`.
If it says the code expired or was already used, tell the user to copy the
setup prompt from the Proto site again and wait for the new prompt. The
embedded setup document is JSON:

```jsonc
{
  "instructions": "...",                       // what to do with the document, one paragraph
  "account": { "id": "<id>", "name": "<name>", "team": "<team>" },
  "codebase": "<id>",                          // Edit prompts only
  "app": "https://...",                        // the Proto app's origin
  "linkingCode": "...",                        // one use, until expiresAt
  "expiresAt": "2026-09-30T12:34:56.000Z",
  "install": {                                 // the plugin command per harness
    "claude": { "install": "...", "update": "..." },
    "codex":  { "install": "...", "update": "..." },
    "cursor": { "install": "...", "update": "..." }
  },
  "prototype": { "slug": "...", "title": "..." }  // Edit prompts only
}
```

The helper's JSON answer is separate from the document:

```jsonc
{
  "summary": "Linked as ada@example.com in Acme; still linked as ada@acme.dev in Acme Labs.",
  "added":   { "user", "team", "laptop", "linkedAt" },  // null when the token it held still works
  "replaced": { … },                           // the same team's previous credential, when there was one
  "kept":    [ { … } ]                         // the other teams this laptop works in, untouched
}
```

The helper keeps a token that already works for this member and team (it
asks `whoami` first), so an Edit prompt on a laptop that is set up does not
spend the code. The setup document carries no durable credential.
Never print or read back a credential's `secret` from config.json.

**Say what linking did**, in the helper's own words: relay `summary`.
It names what this laptop can now do and what it could already do and
still can, which is what tells the user their other team survived. Do
not improve on it by promising that linking is behind them: a person
links once per team, and what the set buys them is that doing so costs
them nothing they already had.

## Machine

### Keep the plugin current

Use GitHub's generated `release` branch for normal installs and updates.
Local files require an explicit user request for this operation; an existing
local registration does not make local the default. Follow the source
selection and migration steps in `../update/SKILL.md` before updating.
An older setup document that names main or an unpinned GitHub source must
use release instead. Never fall back to main when release is unavailable.

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

The link helper writes this file with mode 600. It adds the new
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
reads config.json, so once the link helper has written the file the server
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

- `config.json` parses. For an Edit prompt, `codebase.json` parses,
  names the team it was set up in, and its `source.path` exists.
- The `whoami` MCP tool answers with the expected team and grants.

Report what you set up, leading with the link `summary`: which member
and team this laptop now works as, and which teams it already worked in
and still does. Then anything you skipped because it already existed.

## Editing a prototype

The Edit prompt (`prototype` in the document) means: the creator of
that prototype wants their agent on it again, and the site assumed no
session was open. Only the creator's account can edit a
prototype; the site refuses every other laptop's writes to it in one
sentence, so a document naming a prototype is always the creator's.
Do the machine steps above (the link helper keeps a working token; the
plugin update still applies). If `~/.proto/<codebase>/codebase.json`
does not exist, ask the user to connect the codebase's folder in the
Proto desktop app first. Then:

1. Open the workspace `~/.proto/<codebase>/prototypes/<slug>/`. If it
   does not exist on this laptop, say so in one sentence: the
   prototype was built on another laptop of theirs, and a copy of the
   workspace is needed here before editing.
2. Tell the user, in one line, that you are on "<title>" and ask what
   to change. Wait. Every change follows the edit-variant,
   add-variants, create-variant-set and serve skills as usual (the
   serve run, registration, publish at checkpoints). Finish when the requested change is complete.

## Handoff

Setup ends once the laptop is linked and verified. Existing Edit prompts
use Editing a prototype. No open listening session is needed.
