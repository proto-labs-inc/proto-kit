---
name: setup
description: Set up Proto on this laptop and connect a codebase. Starts from the setup prompt copied from the Proto site, two lines whose second is a one-time link to the setup document: it records your account, finds your codebase folder, creates the codebase in Proto, opens your product page in a Proto browser window, and hands over to the design-system import. Use when a message starts "Set up Proto for account", when installing Proto or connecting a new codebase, or when other Proto skills find no config.json or codebase.json.
---

# Setup

Two scopes, both idempotent: the **machine** (once: config.json,
prerequisites) and a **codebase** (once per codebase being prototyped:
source link, library scaffold). Re-running setup repairs; it never
clobbers working state. **Setup is resumable**: every step below
leaves its result in a file, so if it parks mid-way (waiting on an
engineer, a login, anything), a later "continue setting up Proto"
picks up right where it stopped: say so when you park.

The user is often not an engineer. Two standing rules for the whole
flow: **failures are plain sentences**, never surface raw command
output, stack traces, or anything that reads as an error wall; and
**never send the user to tokens, SSH keys, or GitHub developer
settings**: if access is missing, produce the forwardable message
(below) and park instead.

## Two ways in

**As a command**: with the proto plugin installed, the user runs
`/proto:setup` on Claude Code, `$setup` on Codex, or picks the Proto
setup skill from the chat's `/` menu on Cursor (or just asks to set
up Proto, in the terminal, the Claude Code desktop app, the Codex
app, or Cursor's chat). Nothing was pasted, so ask for the one thing
setup can't derive: the setup prompt, copied from the Proto site's
setup steps or its New prototype dialog (it carries the account, the
credential and everything else below). One question, then proceed
exactly as below once they paste it.

**As the prompt**: pasted from the Proto site. It is two lines. The
first is the sentence the recognizer keys on:

```
Set up Proto for account <name> (<id>).
Fetch <app>/api/setup/<code> and follow it; the document is valid for 15 minutes and works once.
```

A `, codebase <id>` suffix on the first line appears only when
resuming an unfinished setup; a new setup has none, and creating the
codebase is this skill's job (below). Everything else comes from the
document the second line points at. Run the whole flow without
re-asking for anything the document already says.

### The setup document

Fetch the link with a plain HTTPS GET and no auth, `curl -fsS
<link>`, exactly once: the link works one time and expires 15
minutes after the site made it. If you already fetched it before the
plugin was installed (to learn the install command), use that copy;
do not fetch again. A `410` answer means the link has expired or was
already used: tell the user, in its one sentence, to copy the setup
prompt from the Proto site again, and wait for the new prompt. The
document is JSON:

```jsonc
{
  "instructions": "...",                       // what to do with the document, one paragraph
  "account": { "id": "<id>", "name": "<name>" },
  "codebase": "<id>",                          // only when resuming
  "app": "https://...",                        // the Proto app's origin
  "provisionSecret": "...",                    // the credential: config.json only, never the chat
  "install": {                                 // the plugin command per harness
    "claude": { "install": "...", "update": "..." },
    "codex":  { "install": "...", "update": "..." },
    "cursor": { "install": "...", "update": "..." }
  },
  "source": { "folderPath": "..." },           // or { "fingerprint": { "name", "tree": [...] } }, or absent
  "productUrl": "https://...",                 // the product page to parse, or absent
  "brief": { "title", "description", "documentUrl", "referenceHtml", "useRealData" }  // New prototype prompts only
}
```

**Never print `provisionSecret`**, not in a summary, not in a
command the user sees, not in a file other than config.json. Hold
the brief for the handoff. (Account linking will later put a
per-laptop token in `provisionSecret`; nothing here changes shape.)

## Machine

### Keep the plugin current

If the Proto plugin is already installed, update it before anything
else, so setup runs on the latest version, with the document's
`install.<harness>.update` command for the harness you are running
in. Two notes the command does not say: Codex has no plugin update,
so its command re-adds the plugin, which installs the refreshed
snapshot; on Cursor, a Customize-panel install is refreshed by the
user in that panel, a local plugin folder by the `git pull` in the
command, and either way the user then runs **Developer: Reload
Window** so Cursor loads the new copy (the chat survives the
reload).

If an update was installed just now, re-read this skill from the
updated copy before continuing: the text you are following may be
stale.

On Cursor, when the plugin is not installed at all (the prompt was
pasted into a chat without it), install it yourself with the
document's `install.cursor.install` command, tell the user to run
**Developer: Reload Window**, and continue from the installed copy's
`skills/setup/SKILL.md`.

### Prerequisites

`node` (≥ 20), `pnpm`, and `cloudflared` on PATH. Install what's
missing with the user's package manager (macOS: `brew install
cloudflared`); tell them what you installed.

### `~/.proto/config.json`

The account link, the one file every other skill and tool reads
for "who am I and where is the app":

```jsonc
{
  "schemaVersion": 1,
  "app": "https://…",              // the document's app
  "account": { "user": "<id>", "name": "<name>" },   // the document's account; org comes from whoami
  "auth": { "kind": "shared-secret", "secret": "…" },
  "packages": "/abs/path/to/proto/packages",   // optional, pre-npm: the rig's source
  "createdAt": "2026-09-19T…"
}
```

**The auth step is a swappable slot.** Today the document names the
account in plain text and the credential is the shared provisioning
secret. Where the app URL and secret come from, in order: the setup
document (`app` and `provisionSecret`); an existing
`~/.proto/config.json` on this laptop (a resume); the plugin's own
configuration, when the host prompted for the two values at install
(Claude Code, Cursor); otherwise, when setup started as a command
with no prompt, **ask the user to copy the setup prompt from the
Proto site and stop until they paste it**. Never search the disk for
them: a `.env` file belonging to some checkout is not this user's
credential, even if it would work. Record both, then **tell the user
which account they're set up as**, by name. When account linking
ships, the document carries a per-laptop token in the same field and
this step writes a different `auth.kind`: nothing downstream may
depend on the auth kind; everything reads `auth` opaquely and sends
`Authorization: Bearer <auth.secret>`.

`chmod 600` the file: it holds a credential. Registration and every
cloud call use `account.user` as the owner.

### The proto MCP server

The `proto` MCP server is how every kit skill talks to Proto
(tunnels, registration, source registry, comments). In Claude Code it
ships in the plugin: enabling the plugin prompts for the app URL and
provisioning secret, and the server connects with them, nothing to add by
hand. In Cursor it ships in the plugin as the kit's own stdio bridge
(`tools/mcp-stdio.mjs`): it uses the two values from the plugin's
Configure panel when the user entered them, otherwise it reads
config.json, so once this step has written config.json the server
works with nothing else to add. The bridge announces its tools when
config.json appears; if they still do not show, the user toggles the
Proto MCP server off and on in Customize. Its tools may appear under a host-specific scoped name; this and the
other skills refer to them by bare tool name. Write the same two values
into config.json (`app`, `auth.secret`): the kit's plain tools (courier,
supervisor) read config.json, not plugin config.

Running from a bare checkout instead, add the server manually in Claude
Code:
`claude mcp add --transport http proto <app>/api/mcp --header
"Authorization: Bearer <auth.secret>"`.

**On Codex** the server is added at setup time (its plugin config
can't read config.json): write to `~/.codex/config.toml`, values
from config.json, the header through the kit's helper so the
credential stays in one file:

```toml
[mcp_servers.proto]
url = "<app>/api/mcp"
http_headers_helper = "node <kit>/tools/mcp-headers.mjs"
```

Also install the agent roles (Codex plugins don't ship them): copy
`<kit>/codex-agents/*.toml` into `~/.codex/agents/`.

Either way, confirm with the `whoami` tool: it reports the auth
mode, org, and grants. A connected server whose `whoami` fails means
the credential is stale: redo the auth step above.

## Codebase

A codebase is one codebase being prototyped, keyed everywhere by a
cloud-minted id: `~/.proto/<id>/` on the laptop, and the id in every
later call. Its display name is separate and renamable; never derive
a path or slug from it. The codebase is the team's. Tunnels are
never named after it: they use per-laptop ids the cloud mints at
courier registration (`c-<courierId>`, and the library's
`libraryId`), stored in the run dir.

**The codebase is created here**, once the codebase is found: call
`set_codebase_source` with **no `codebase` field**. The server
creates the codebase, names it after the source folder, and returns
the id. Keep that id for everything that follows. When the document
carries `codebase` (resuming an unfinished setup), skip creation and
use that id.

### Find their code

You need the codebase's repo on this machine. Before anything else,
give the one reassurance that matters, in exactly this plain shape:
**"Your code stays on your laptop; Proto receives only the design
system it extracts."**

0. **The fingerprint, when the document carries one.** The
   document's `source.fingerprint` names the folder and lists a
   shallow tree of its entry names (`▸` folders, `•` files, two
   levels). Search the likely roots,
   the current working directory first, then the home folder and
   common project folders (`~/Projects`, `~/code`, `~/src`, `~/dev`,
   `~/work`, `~/Documents`), two or three levels deep, and score
   each candidate: exact folder-name match, then how many of the
   listed entries exist inside. One clear winner: confirm it in one
   line ("Using `~/Projects/inbox`. The tree matches.") and
   continue. More than one plausible match: ask which one, listing
   the paths. None: fall to the ask below. A `source.folderPath`
   skips all of this; no `source` at all starts at step 1.
1. **Silent scan first, the engineer fast path.** Quietly look for
   checkouts in the obvious places (`~/Projects`, `~/code`, `~/src`,
   `~/dev`, `~/work`, one or two levels deep for `.git`), matching
   directory names, `package.json` names, and git remotes against
   anything the document or conversation names. On a hit, ask ONE
   confirmation question with the evidence in it ("Is it
   `~/Projects/cobble-web`?"). **Fail soft**: if the scan finds
   nothing, just move to the ask: never announce "no repositories
   found".
2. **Ask without jargon, either/or.** "Is your codebase on this
   laptop, or on GitHub?" No "checked out", no "clone", no assuming
   one repo.
3. **Scraps are a full answer.** A PR link, a repo link, "we're
   acme, it's on GitHub": derive the repo yourself (a PR/issue URL
   names its repo; `gh pr view <url>` does too; a live URL's domain
   often names the org). Don't ask for a path when a scrap will do.
4. **Never ask two unanswerable questions in a row.** Every question
   must be answerable from what the user obviously knows, and must
   carry your best guess so a "yes" is enough.
5. **Get it locally with the auth that already exists** (`gh repo
   clone`, or plain `git clone` of a URL that works). **Never** route
   the user to tokens, SSH keys, or GitHub developer settings. If
   cloning fails for access reasons, say so in one plain sentence,
   hand them this to forward: "Could you run: `git clone
   <repo url>` into a folder on my laptop, or send me an invite so
   `git clone` works? It's for Proto, which reads the design system
   locally.", and **park**: tell them setup will pick up right here
   once the repo exists, and mean it (re-running setup resumes from
   files, not memory).
6. **Create or record the codebase** once confirmed:
   `set_codebase_source { sourcePath, repoRemote, account }`.
   `account` is config.json's `account.user`. With no `codebase`
   field the server creates the codebase, names it after the source
   folder, and returns the id that keys everything from here on.
   Resuming with a known id, pass `codebase` and the call records the
   source instead. The local `codebase.json` below stays the laptop's
   copy of the same pointers.

### `~/.proto/<codebase>/codebase.json`

```jsonc
{
  "schemaVersion": 1,
  "codebase": "<id>",                   // the cloud-minted id
  "name": "acme-web",                  // display name; renamable, never a path
  "source": {
    "path": "/abs/path/to/acme-web",   // the checkout
    "remote": "git@github.com:acme/acme-web.git",
    "liveUrl": "https://…"             // where the codebase runs, if known:
  },                                   //  the import skill wants it
  "createdAt": "2026-09-19T…"
}
```

### Library scaffold

Copy `template/library/` → `~/.proto/<codebase>/library/` (skip if it
already has a manifest with content). The import-design-system skill
fills it; the serve skill serves it.

### The reference page (the Proto window)

Prototypes and imports read the user's live product through their own
browser. Set that up once per machine, here:

1. Start the dedicated Proto Chrome window: `node
   tools/cdp/chrome.mjs` (resolve kit tools from the installed host's
   `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, or `CURSOR_PLUGIN_ROOT`;
   otherwise use the root above this skill's `skills/` directory). Its profile lives at
   `~/.proto/chrome`, so logins persist across sessions and reboots;
   the login is one-time.
2. The document's `productUrl` is the product page to parse; with
   none, ask the user for the URL of a page in their product. Open it
   in that window yourself, over CDP:
   `openBackground(url)` from `tools/cdp/attach.mjs`, then read the
   page (`evaluate`) for a signed-in marker: the user's name in a
   greeting or menu, an account control, no sign-in form. **Never
   drive the browser's interface** (no clicking its address bar, no
   typing into it, no computer-use automation): the kit reads pages
   through the debug port only. If the page shows no signed-in
   marker, tell the user to sign in in the Proto window and wait
   until they say they have; then read again. Record the page in
   `codebase.json` as `source.liveUrl`: the import-design-system
   skill takes it from there instead of asking again.
3. From then on, skills find the page by looking at the open tabs
   over CDP (prefer the active tab; offer a pick when several
   match). Pasting a URL into the chat is always an accepted
   fallback: never a required step.

### The product's icon

Codebases carry a favicon the agent sets itself, right after the
Proto window step, while the product's live page is open there:

1. Prefer the live page's own icon: read its `<link rel="icon">`
   candidates over CDP and take the largest png/svg.
2. Else scan the repo: `public/favicon.*`, `app/icon.*`,
   `src/app/icon.*`.
3. Convert to a data URL (png/svg/ico, ≤ 256 KB: pick a size that
   fits) and call the `set_codebase_icon` MCP tool with
   `{ account, codebase, image }` (`account` = config.json's
   `account.user`).
4. **Fail soft.** Nothing usable found → skip silently and move on;
   the site shows a letter fallback. No icon is ever worth a
   question or an error sentence.

### Migration: pre-rename homes

This concept was called "project", then "product", before
"codebase". If a home has `project.json` or `product.json`, repair
it in place: rename the file to `codebase.json` and its `"project"`
or `"product"` key to `"codebase"` (same for a `courier.json`
carrying either old key, and a library `manifest.json` with either
old field). Nothing running is affected: supervisors and run-dir
specs never reference these files by those names, so migrate
without stopping anything.

## Verify

- `config.json` and `codebase.json` parse; `source.path` exists and its
  `package.json`/remote match the codebase (they can legitimately
  disagree with each other, a fork or renamed checkout, which is
  why confirmation beat validation above).
- The `whoami` MCP tool answers with the expected org and grants.
- `cloudflared --version` runs.

Report what you set up, leading with which account they're set up
as, what you found vs. were told, and anything you skipped because
it already existed.

## Handoff

Setup ends by continuing, not by stopping:

1. Run **import-design-system** against the found source + the Proto
   window's live page: the library filling in is the first thing the
   user watches.
2. If the document carried a `brief`, hand it to **create-prototype**
   verbatim: title, description, the brief document URL, the
   reference page (`productUrl`), the reference HTML (structure
   hints only: the live page wins) and whether to use real data.
   Registration there uses `account.user` as owner.
3. End by telling the user, plainly: **keep this session open, it's
   your codebase's agent.** And one more sentence once the first
   import has finished: the library is published, so it stays
   viewable after this laptop closes. This very session (in the terminal, the
   Claude Code desktop app, the Codex app, or Cursor's chat) is what receives the site's commands;
   continue into the listen skill. Closing it doesn't lose
   anything: commands queue in the feed, but nothing runs until a
   session picks the protocol up again.
