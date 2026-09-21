---
name: setup
description: Set up Proto on this laptop and connect a codebase. Starts from the setup prompt copied from the Proto site: it records your account, finds your codebase folder, creates the product in Proto, opens your product page in a Proto browser window, and hands over to the design-system import. Use when a message starts "Set up Proto for account", when installing Proto or connecting a new product, or when other Proto skills find no config.json or product.json.
---

# Setup

Two scopes, both idempotent: the **machine** (once — config.json,
prerequisites) and a **product** (once per product being prototyped —
source link, library scaffold). Re-running setup repairs; it never
clobbers working state. **Setup is resumable**: every step below
leaves its result in a file, so if it parks mid-way (waiting on an
engineer, a login, anything), a later "continue setting up Proto"
picks up right where it stopped — say so when you park.

The user is often not an engineer. Two standing rules for the whole
flow: **failures are plain sentences** — never surface raw command
output, stack traces, or anything that reads as an error wall; and
**never send the user to tokens, SSH keys, or GitHub developer
settings** — if access is missing, produce the forwardable message
(below) and park instead.

## Two ways in

**As a command** — with the proto plugin installed, the user runs
`/proto:setup` on Claude Code, or `$setup` on Codex (or just asks to
set up Proto — in the terminal, the Claude Code desktop app, or the
Codex app). Nothing was pasted, so ask for the one thing setup can't
derive: the account, as the Proto site shows it (name and id) — one
question, then proceed exactly as below. If they paste the snippet
in reply, even better.

**As the snippet** — pasted from the Proto site. Its first line is
the sentence the recognizer keys on:

```
Set up Proto for account <name> (<id>).
```

A `, product <id>` suffix appears only when resuming an unfinished
setup; a new setup has none, and creating the product is this
skill's job (below). For signed-in users the snippet then carries
the two cloud values, one per line:

```
Proto app: <url>
Provisioning secret: <secret>
```

The next line always says: identify your
harness, install proto-kit for it, and follow this skill. The same
line then carries two pointers, each in one of a few shapes:

- **The codebase**: `Use the codebase at "<path>".`, or `Locate the
  codebase directory named "<folder>" on this laptop.` followed by a
  names-only tree to match (see **Find their code**), or `Ask me to
  choose the folder that contains my codebase.`
- **The product page**: `Use "<url>" as the product page to parse.`
  or the ask-me variant — always with the instruction to confirm the
  user is logged in first and wait if not.

The New prototype dialog's snippet is the same two lines followed by
`After setup, create a prototype with this brief:` and Title,
Description, Reference page, Reference HTML — hold the brief for the
handoff. Run the whole flow without re-asking for anything the
snippet already says. (Account linking will later swap the
plain-text account for a token the same entry point redeems.)

## Machine

### Keep the plugin current

If the Proto plugin is already installed, update it before anything
else, so setup runs on the latest version:

- Claude Code: `claude plugin marketplace update proto-kit && claude
  plugin update proto@proto-kit`
- Codex: `codex plugin marketplace upgrade proto-kit && codex plugin
  add proto@proto-kit` (Codex has no plugin update; re-adding
  installs the refreshed snapshot)
- Cursor: update it from the Customize panel.

If an update was installed just now, re-read this skill from the
updated copy before continuing: the text you are following may be
stale.

### Prerequisites

`node` (≥ 20), `pnpm`, and `cloudflared` on PATH. Install what's
missing with the user's package manager (macOS: `brew install
cloudflared`); tell them what you installed.

### `~/.proto/config.json`

The account link — the one file every other skill and the CLI reads
for "who am I and where is the app":

```jsonc
{
  "schemaVersion": 1,
  "app": "https://…",              // the Proto app's origin — from the user
                                   //  or a proto checkout's .env (PROTO_APP_DOMAIN).
                                   //  Domains live here and in .env only, never in code or docs.
  "account": { "user": "<id>", "name": "<name>" },   // both from the snippet; org comes from whoami
  "auth": { "kind": "shared-secret", "secret": "…" },
  "packages": "/abs/path/to/proto/packages",   // optional, pre-npm: the rig's source
  "createdAt": "2026-09-19T…"
}
```

**The auth step is a swappable slot.** Today the snippet names the
account in plain text and the credential is the shared provisioning
secret. Where the app URL and secret come from, in order: the
snippet itself, when it carries the `Proto app:` and `Provisioning
secret:` lines; an existing `~/.proto/config.json` on this laptop (a
resume); the plugin's own configuration, when the host prompted for
the two values at install (Claude Code, Cursor); otherwise **ask the
user for the two values and stop until they answer**. Never search the disk for them: a `.env` file
belonging to some checkout is not this user's credential, even if it
would work. Record both, then **tell the user which account they're
set up as**, by name. When account linking ships, this same step
redeems a token from the snippet instead and writes a different
`auth.kind` — nothing downstream may depend on the auth kind;
everything reads `auth` opaquely and sends `Authorization: Bearer
<auth.secret>`.

`chmod 600` the file — it holds a credential. Registration and every
cloud call use `account.user` as the owner.

### The proto MCP server

The `proto` MCP server is how every kit skill talks to Proto
(tunnels, registration, source registry, comments). In Claude and Cursor,
it ships in the plugin: enabling the plugin prompts for the app URL and
provisioning secret, and the server connects with them — nothing to add by
hand. Its tools may appear under a host-specific scoped name; this and the
other skills refer to them by bare tool name. Write the same two values
into config.json (`app`, `auth.secret`) — the kit's plain tools (courier,
supervisor) read config.json, not plugin config.

Running from a bare checkout instead, add the server manually in Claude
Code:
`claude mcp add --transport http proto <app>/api/mcp --header
"Authorization: Bearer <auth.secret>"`.

**On Codex** the server is added at setup time (its plugin config
can't read config.json): write to `~/.codex/config.toml`, values
from config.json, the header through the kit's helper so the
credential stays in one file —

```toml
[mcp_servers.proto]
url = "<app>/api/mcp"
http_headers_helper = "node <kit>/tools/mcp-headers.mjs"
```

Also install the agent roles (Codex plugins don't ship them): copy
`<kit>/codex-agents/*.toml` into `~/.codex/agents/`.

Either way, confirm with the `whoami` tool: it reports the auth
mode, org, and grants. A connected server whose `whoami` fails means
the credential is stale — redo the auth step above.

## Product

A product is one product being prototyped, keyed everywhere by a
cloud-minted id: `~/.proto/<id>/` on the laptop, and the id in every
later call. Its display name is separate and renamable; never derive
a path or slug from it. The product is the team's — tunnels are
never named after it: they use per-laptop ids the cloud mints at
courier registration (`c-<courierId>`, and the library's
`libraryId`), stored in the run dir.

**The product is created here**, once the codebase is found: call
`set_product_source` with **no `product` field** — the server
creates the product, names it after the source folder, and returns
the id. Keep that id for everything that follows. When the snippet
carries `, product <id>` (resuming an unfinished setup), skip
creation and use that id.

### Find their code

You need the product's repo on this machine. Before anything else,
give the one reassurance that matters, in exactly this plain shape:
**"Your code stays on your laptop; Proto receives only the design
system it extracts."**

0. **The fingerprint, when the snippet carries one.** The snippet
   may name the folder and list a shallow tree of its entry names
   (`▸` folders, `•` files, two levels). Search the likely roots —
   the current working directory first, then the home folder and
   common project folders (`~/Projects`, `~/code`, `~/src`, `~/dev`,
   `~/work`, `~/Documents`), two or three levels deep — and score
   each candidate: exact folder-name match, then how many of the
   listed entries exist inside. One clear winner: confirm it in one
   line ("Using `~/Projects/inbox`. The tree matches.") and
   continue. More than one plausible match: ask which one, listing
   the paths. None: fall to the ask below. A `Use the codebase at
   "<path>".` line skips all of this; an ask-me line starts at
   step 2.
1. **Silent scan first — the engineer fast path.** Quietly look for
   checkouts in the obvious places (`~/Projects`, `~/code`, `~/src`,
   `~/dev`, `~/work`, one or two levels deep for `.git`), matching
   directory names, `package.json` names, and git remotes against
   anything the snippet or conversation names. On a hit, ask ONE
   confirmation question with the evidence in it ("Is it
   `~/Projects/cobble-web`?"). **Fail soft**: if the scan finds
   nothing, just move to the ask — never announce "no repositories
   found".
2. **Ask without jargon, either/or.** "Is your product's code on this
   laptop, or on GitHub?" No "checked out", no "clone", no assuming
   one repo.
3. **Scraps are a full answer.** A PR link, a repo link, "we're
   acme, it's on GitHub" — derive the repo yourself (a PR/issue URL
   names its repo; `gh pr view <url>` does too; a live URL's domain
   often names the org). Don't ask for a path when a scrap will do.
4. **Never ask two unanswerable questions in a row.** Every question
   must be answerable from what the user obviously knows, and must
   carry your best guess so a "yes" is enough.
5. **Get it locally with the auth that already exists** (`gh repo
   clone`, or plain `git clone` of a URL that works). **Never** route
   the user to tokens, SSH keys, or GitHub developer settings. If
   cloning fails for access reasons, say so in one plain sentence,
   hand them this to forward — "Could you run: `git clone
   <repo url>` into a folder on my laptop, or send me an invite so
   `git clone` works? It's for Proto, which reads the design system
   locally." — and **park**: tell them setup will pick up right here
   once the repo exists, and mean it (re-running setup resumes from
   files, not memory).
6. **Create or record the product** once confirmed:
   `set_product_source { sourcePath, repoRemote, account }` —
   `account` is config.json's `account.user`. With no `product`
   field the server creates the product, names it after the source
   folder, and returns the id that keys everything from here on.
   Resuming with a known id, pass `product` and the call records the
   source instead. The local `product.json` below stays the laptop's
   copy of the same pointers.

### `~/.proto/<product>/product.json`

```jsonc
{
  "schemaVersion": 1,
  "product": "<id>",                   // the cloud-minted id
  "name": "acme-web",                  // display name; renamable, never a path
  "source": {
    "path": "/abs/path/to/acme-web",   // the checkout
    "remote": "git@github.com:acme/acme-web.git",
    "liveUrl": "https://…"             // where the product runs, if known —
  },                                   //  the import skill wants it
  "createdAt": "2026-09-19T…"
}
```

### Library scaffold

Copy `template/library/` → `~/.proto/<product>/library/` (skip if it
already has a manifest with content). The import-design-system skill
fills it; the serve skill serves it.

### The reference page (the Proto window)

Prototypes and imports read the user's live product through their own
browser. Set that up once per machine, here:

1. Start the dedicated Proto Chrome window: `node
   tools/cdp/chrome.mjs` (resolve kit tools from the installed host's
   `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, or `CURSOR_PLUGIN_ROOT`;
   otherwise use the root above this skill's `skills/` directory) — its profile lives at
   `~/.proto/chrome`, so logins persist across sessions and reboots;
   the login is one-time.
2. The snippet names the product page to parse (or says to ask for
   one). Open it in that window yourself, over CDP:
   `openBackground(url)` from `tools/cdp/attach.mjs`, then read the
   page (`evaluate`) for a signed-in marker: the user's name in a
   greeting or menu, an account control, no sign-in form. **Never
   drive the browser's interface** (no clicking its address bar, no
   typing into it, no computer-use automation): the kit reads pages
   through the debug port only. If the page shows no signed-in
   marker, tell the user to sign in in the Proto window and wait
   until they say they have; then read again. Record the page in
   `product.json` as `source.liveUrl` — the import-design-system
   skill takes it from there instead of asking again.
3. From then on, skills find the page by looking at the open tabs
   over CDP (prefer the active tab; offer a pick when several
   match). Pasting a URL into the chat is always an accepted
   fallback — never a required step.

### The product's icon

Products carry a favicon the agent sets itself — right after the
Proto window step, while the product's live page is open there:

1. Prefer the live page's own icon: read its `<link rel="icon">`
   candidates over CDP and take the largest png/svg.
2. Else scan the repo: `public/favicon.*`, `app/icon.*`,
   `src/app/icon.*`.
3. Convert to a data URL (png/svg/ico, ≤ 256 KB — pick a size that
   fits) and call the `set_product_icon` MCP tool with
   `{ account, product, image }` (`account` = config.json's
   `account.user`).
4. **Fail soft.** Nothing usable found → skip silently and move on;
   the site shows a letter fallback. No icon is ever worth a
   question or an error sentence.

### Migration: pre-rename homes (before 2026-09-20 "product")

This concept was briefly called "project". If a home has
`project.json`, repair it in place: rename the file to `product.json`
and its `"project"` key to `"product"` (same for a `courier.json`
carrying a `"project"` key, and a library `manifest.json` with a
`"project"` field). Nothing running is affected — supervisors and
run-dir specs never reference these files by that name — so migrate
without stopping anything.

## Verify

- `config.json` and `product.json` parse; `source.path` exists and its
  `package.json`/remote match the product (they can legitimately
  disagree with each other — a fork or renamed checkout — which is
  why confirmation beat validation above).
- The `whoami` MCP tool answers with the expected org and grants.
- `cloudflared --version` runs.

Report what you set up — leading with which account they're set up
as — what you found vs. were told, and anything you skipped because
it already existed.

## Handoff

Setup ends by continuing, not by stopping:

1. Run **import-design-system** against the found source + the Proto
   window's live page — the library filling in is the first thing the
   user watches.
2. If the snippet carried a brief, hand it to **create-prototype**
   verbatim: title, description, reference page URL, and the
   reference HTML (structure hints only — the live page wins).
   Registration there uses `account.user` as owner.
3. End by telling the user, plainly: **keep this session open — it's
   your product's agent.** And one more sentence once the first
   import has finished: the library is published, so it stays
   viewable after this laptop closes. This very session (in the terminal or the
   Claude Code desktop app) is what receives the site's commands;
   continue into the listen skill. Closing it doesn't lose
   anything — commands queue in the feed — but nothing runs until a
   session picks the protocol up again.
