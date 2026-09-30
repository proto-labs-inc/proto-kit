---
name: setup
description: >-
  Set up Proto on this laptop and connect a codebase. Starts from the setup
  prompt copied from the Proto site, two lines whose second is a one-time link
  to the setup document: it links this laptop, finds your codebase folder,
  creates the codebase in Proto, opens your product page in a Proto browser
  window, attaches the prepared onboarding design system, and starts the
  courier. Use when a message starts
  "Set up Proto for", when installing Proto or connecting a new
  codebase, or when other Proto skills find no config.json or codebase.json.
---

# Setup

Two scopes, both idempotent: the **machine** (once: config.json,
prerequisites) and a **codebase** (once per codebase being prototyped:
source link, onboarding library attachment). Re-running setup repairs; it never
clobbers working state. **Setup is resumable**: every step below
leaves its result in a file, so if it parks mid-way (waiting on an
engineer, a login, anything), a later "continue setting up Proto"
picks up right where it stopped: say so when you park.

### Resume audit: do this before setup work

After fetching the setup document, inspect the saved state before carrying
out any machine, codebase, import, courier, or prototype step. The document's
`codebase` is a resume key, not an instruction to rebuild that codebase.

- If `~/.proto/config.json` already identifies the document's app and member
  and `whoami` succeeds, the machine is linked. Keep it. Only repair a missing
  or stale MCP entry, agent role, or prerequisite.
- If the document carries `codebase` and
  `~/.proto/<codebase>/codebase.json` exists and parses, use its recorded
  source path, remote, and live URL. Do not scan for the repo, ask the user to
  confirm it, call `set_codebase_source`, or rewrite the file unless a recorded
  value is missing, invalid, or the user explicitly changes it.
- Inspect the courier state and local prototype workspaces before starting
  their skills. A healthy existing result is completed work, not a reason to
  recreate it. Start or repair only the missing or unhealthy process. Do not
  start or resume a design-system import during setup.
- If the brief already has a matching registered or local prototype, resume
  that prototype. Never create a duplicate merely because the setup document
  carries the brief again.

Use the cheapest authoritative check for each item. Report what was already
complete separately from what you repaired or created. Do not ask the user to
reconfirm saved facts just because setup was invoked again.

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
setup steps or its New prototype dialog (it carries the identity and
everything else below). One question, then proceed
exactly as below once they paste it.

**As the prompt**: pasted from the Proto site. It is two lines. The
first is the sentence the recognizer keys on:

```
Set up Proto for <name> (<id>) at <org>.
Fetch <app>/api/setup/<code> and follow it; the link is valid for 10 minutes and works once.
```

A `, codebase <id>` suffix on the first line appears when resuming an
unfinished setup; a new setup has none, and creating the codebase is
this skill's job (below). A `, codebase <id>, prototype <slug>` suffix
is the **Edit prompt**, copied from a prototype's Frame by its creator
when their agent was not listening: see "Editing a prototype" at the
end. Everything else comes from the document the second line points
at. Run the whole flow without re-asking for anything the document
already says.

### The setup document

Run `node <kit>/tools/link-laptop.mjs <link>` exactly once. The helper
fetches the setup document, exchanges the same code for this laptop's
token, writes the token directly to `~/.proto/config.json`, and prints
only the non-secret document and linked identity. The link expires ten
minutes after the site made it. If it says the link expired or was
already used, tell the user to copy the setup prompt from the Proto site
again and wait for the new prompt. The printed setup document is JSON:

```jsonc
{
  "instructions": "...",                       // what to do with the document, one paragraph
  "account": { "id": "<id>", "name": "<name>", "org": "<org>" },
  "codebase": "<id>",                          // only when resuming
  "app": "https://...",                        // the Proto app's origin
  "install": {                                 // the plugin command per harness
    "claude": { "install": "...", "update": "..." },
    "codex":  { "install": "...", "update": "..." },
    "cursor": { "install": "...", "update": "..." }
  },
  "source": { "folderPath": "..." },           // or { "fingerprint": { "name", "tree": [...] } }, or absent
  "productUrl": "https://...",                 // the product page to parse, or absent
  "brief": { "title", "description", "documentUrl", "referenceHtml", "useRealData" },  // New prototype prompts only
  "prototype": { "slug": "...", "title": "..." }   // Edit prompts only
}
```

The helper keeps a token that already works for this member (it asks
`whoami` first), so an Edit prompt on a laptop that is set up spends the
code on the document alone. The setup document carries no credential. Never print or read back
`auth.secret` from config.json. Hold the brief for the handoff.

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

The laptop link, the one file every other skill and tool reads
for "who am I and where is the app":

```jsonc
{
  "schemaVersion": 2,
  "app": "https://…",              // the document's app
  "auth": { "kind": "laptop-token", "secret": "…" },
  "user": { "id": "<id>", "name": "<name>", "email": "…" },
  "org": { "id": "<id>", "name": "<name>" },
  "laptop": { "id": "<id>", "label": "<hostname>" },
  "packages": "/abs/path/to/proto/packages",   // optional, pre-npm: the rig's source
  "createdAt": "2026-09-19T…"
}
```

The link helper writes this file with mode 600. When setup started as
a command with no prompt, ask the user to copy the setup prompt from
the Proto site and stop until they paste it. Never search the disk for
a credential: a `.env` file belonging to a checkout is not this
laptop's credential. Every cloud call sends `Authorization: Bearer
<auth.secret>`; the server derives the member and org from that token.

### The proto MCP server

The `proto` MCP server is how every kit skill talks to Proto
(tunnels, registration, source registry, comments). In Claude Code and
Cursor it ships as the kit's stdio bridge (`tools/mcp-stdio.mjs`), which
reads config.json, so once the link helper has written the file the server
works with nothing else to add. The bridge announces its tools when
config.json appears; if they still do not show, the user toggles the
Proto MCP server off and on in Customize. Its tools may appear under a host-specific scoped name; this and the
other skills refer to them by bare tool name. The kit's plain tools
(courier, supervisor, publisher) read the same config.json.

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
provisioned by target, never by a name you compose: the courier's by
the per-laptop `courierId` the cloud mints at courier registration
(stored in the run dir with the library's `libraryId`), the library's
by the codebase id. The site chooses and stores every address.

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
   `set_codebase_source { sourcePath, repoRemote }`. With no `codebase`
   field the server creates the codebase in the laptop token's org and names it after the source
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

### Leave the local library stopped

Do not scaffold, host, or import a local library during setup. The prepared
onboarding library is attached by the cloud only after the real codebase and
courier are ready. An explicit later design-system import owns starting the
local library host.

### The reference page (the Proto window)

Prototypes and imports read the user's live product through a browser.
Reuse the user's existing browser state before creating any window or tab:

1. Resolve the document's `productUrl`; with none, ask for a URL of a page
   in the product. Before launching Chrome or calling `openBackground`,
   inspect every browser window and tab the current coding host can already
   read, including an already-running Proto Chrome on port 9333 and any
   available in-app or user-Chrome browser tool. Prefer an exact URL match,
   then the same project or product path, then the same origin. When a
   matching signed-in page provides the DOM and capture access the import
   needs, use that page as the reference. Do not launch another browser or
   open a duplicate tab.
2. Only when no usable matching page is already open, start the dedicated
   Proto Chrome window with `node tools/cdp/chrome.mjs` (resolve kit tools
   from the installed host's `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, or
   `CURSOR_PLUGIN_ROOT`; otherwise use the root above this skill's `skills/`
   directory). Its profile lives at `~/.proto/chrome`, so logins persist
   across sessions and reboots. After it starts, call `listPages()` from
   `tools/cdp/attach.mjs` and reuse a matching tab if one appeared. Call
   `openBackground(url)` only when no matching tab exists.
3. Read the selected page for a signed-in marker: the user's name in a
   greeting or menu, an account control, and no sign-in form. **Never drive
   the browser's interface** (no clicking its address bar, no typing into it,
   no computer-use automation). If the page is not signed in, tell the user
   which existing window contains it and wait for them to sign in there;
   then read the same page again. Record its final URL in `codebase.json` as
   `source.liveUrl`: the import-design-system skill takes it from there
   instead of asking again.
4. From then on, skills find the page by looking at the open tabs in the
   selected browser context (prefer the active tab; offer a pick when several
   match). Pasting a URL into the chat is always an accepted fallback: never
   a required step.

### The product's icon

Codebases carry a favicon the agent sets itself, right after the
Proto window step, while the product's live page is open there:

1. Prefer the live page's own icon: read its `<link rel="icon">`
   candidates over CDP and take the largest png/svg.
2. Else scan the repo: `public/favicon.*`, `app/icon.*`,
   `src/app/icon.*`.
3. Convert to a data URL (png/svg/ico, ≤ 256 KB: pick a size that
   fits) and call the `set_codebase_icon` MCP tool with
   `{ codebase, image }`. The laptop token supplies the member and org.
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

Report what you set up, leading with which member and org they're linked
as, what you found vs. were told, and anything you skipped because
it already existed.

## Editing a prototype

The Edit prompt (`prototype` in the document) means: the creator of
that prototype wants their agent on it again, and the site assumed no
session was listening. Only the creator's account can edit a
prototype; the site refuses every other laptop's writes to it in one
sentence, so a document naming a prototype is always the creator's.
Do the machine steps above (the link helper keeps a working token; the
plugin update still applies), skip the codebase steps when
`~/.proto/<codebase>/codebase.json` exists (else do them: the
codebase id is in the document), then:

1. Open the workspace `~/.proto/<codebase>/prototypes/<slug>/`. If it
   does not exist on this laptop, say so in one sentence: the
   prototype was built on another laptop of theirs, and a copy of the
   workspace is needed here before editing.
2. Tell the user, in one line, that you are on "<title>" and ask what
   to change. Wait. Every change follows the create-prototype and
   serve skills as usual (the serve run, registration, publish at
   checkpoints), and this session keeps listening for the site's
   commands afterwards (the listen skill).

## Handoff

Setup ends by continuing, not by stopping (an Edit prompt ends at
"Editing a prototype" above instead):

1. Follow **serve**'s "The courier" section for this codebase to create or
   repair its real courier. Verify its supervisor reports both the listener
   and tunnel up. Then enter **listen**, arm this session's command-feed
   watch, and wait until the courier heartbeat reports this agent as
   listening. Do not invoke `create-prototype` until all of those checks pass.
   This lets the site receive and display progress for the entire prototype
   build, including work started directly from this setup prompt.
2. Call `attach_onboarding_library { codebase }`. This must happen only after
   step 1 is healthy. The operation is idempotent, so retry it once if the
   call is interrupted or reports a transient failure. Do not run
   **import-design-system** during setup. If attachment still fails, remain
   in setup, tell the user in one plain sentence that Proto could not finish
   the design system, and offer to retry. Never continue to success or create
   a prototype until attachment succeeds.
3. If the document carried a `brief`, first check for a matching registered
   or local prototype. Resume it when found. Only when none exists, hand the
   brief to **create-prototype** verbatim: title, description, the brief
   document URL, the reference page (`productUrl`), the reference HTML
   (structure hints only: the live page wins) and whether to use real data.
   Registration there uses the laptop token's member as creator.
4. End by telling the user, plainly: **keep this session open, it's
   your codebase's agent.** And one more sentence once the first
   attachment has finished: the library is published, so it stays
   viewable after this laptop closes. This very session (in the terminal, the
   Claude Code desktop app, the Codex app, or Cursor's chat) is what receives the site's commands;
   continue into the listen skill. Closing it doesn't lose
   anything: commands queue in the feed, but nothing runs until a
   session picks the protocol up again.
