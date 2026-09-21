---
name: setup
description: Set up Proto on this machine and link a product — the pasted Proto setup snippet is the entry point (account + prototype brief), credentials into ~/.proto/config.json, find the product's source repo from whatever scraps the user gives, scaffold the product's ~/.proto/<product>/ home. Use when a message starts "Set up Proto for account …", when installing Proto or connecting a new product, or when other Proto skills find no config.json or product.json.
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
`/proto:setup` (or just asks to set up Proto). Nothing was pasted, so
ask for the one thing setup can't derive: the account, as the Proto
site shows it (name and id) — one question, then proceed exactly as
below. If they paste the snippet in reply, even better.

**As the snippet** — a pasted snippet from the Proto site, in one of
two shapes — with a prototype brief:

```
Set up Proto for account <name> (<id>)[, product <name>]. Get
proto-kit from <the kit repo> and follow skills/setup/SKILL.md.
Then create a prototype with this brief:
Title: …
Description: …
Reference page: <url>
Reference HTML: (included below if any)
```

— or setup-only: the same first two sentences and nothing after
them.

Recognize both and: take `<id>`/`<name>` as the account for
config.json below; when the first sentence names a product, that IS
the product's name (it beats the repo-name default); hold the brief
(title, description, reference page, reference HTML) for the handoff
at the end when there is one. Run the whole flow without re-asking
for anything the snippet already says. (Account linking will later
swap the plain-text account for a token the same entry point
redeems — the flow's shape does not change.)

## Machine

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
secret already on this laptop (an existing config.json, or a proto
checkout's `.env` — `PROTO_PROVISION_SECRET`). Record both, then
**tell the user which account they're set up as**, by name. When
account linking ships, this same step redeems a token from the
snippet instead and writes a different `auth.kind` — nothing
downstream may depend on the auth kind; everything reads `auth`
opaquely and sends `Authorization: Bearer <auth.secret>`.

`chmod 600` the file — it holds a credential. Registration and every
cloud call use `account.user` as the owner.

### The cloud MCP server

The `cloud` MCP server is how every kit skill talks to Proto
(tunnels, registration, source registry, comments). Installed as the
proto plugin, it ships in the plugin: enabling the plugin prompts for
the app URL and provisioning secret (the plugin's user config), and
the server connects with them — nothing to add by hand. Its tools
appear under the plugin's scoped names
(`mcp__plugin_proto_cloud__<tool>`); this and the other skills refer
to them by bare tool name. Write the same two values into
config.json (`app`, `auth.secret`) — the kit's plain tools (courier,
supervisor) read config.json, not plugin config.

Running from a bare checkout instead, add the server manually:
`claude mcp add --transport http proto <app>/api/mcp --header
"Authorization: Bearer <auth.secret>"`.

Either way, confirm with the `whoami` tool: it reports the auth
mode, org, and grants. A connected server whose `whoami` fails means
the credential is stale — redo the auth step above.

## Product

A product is one product being prototyped: `~/.proto/<product>/`,
slug-named after the product. The product is decided here, before
any prototype exists. Its name: the snippet's `, product <name>`
when present, else **default to the repo's name** once the repo is
found — most users never touch it; only ask if something already
occupies that name.

**Product identity — incoming contract.** The site is moving to a
stable random id per product (short lowercase alphanumerics,
site-generated at creation) with a separate, renamable display name.
Once snippets carry an id in `product <id>`: key laptop paths by the
id (`~/.proto/<id>/`) and record the display name in `product.json`
as `name`, display-only. Never derive a path or slug from the
display name; names rename, ids don't. The product is the team's —
tunnels are never named after it: they use per-LAPTOP ids the cloud
mints at courier registration (`c-<courierId>`, and the library's
`libraryId`), stored in the run dir. Until an id arrives, the
slug-named flow above stands.

### Find their code

You need the product's repo on this machine. Before anything else,
give the one reassurance that matters, in exactly this plain shape:
**"Your code stays on your laptop; Proto receives only the design
system it extracts."**

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
6. **Record it in the cloud** once confirmed: the
   `set_product_source` MCP tool with
   `{ product, sourcePath, repoRemote, account }` — `account` is
   config.json's `account.user`, and it's required (the cloud stamps
   who created the product and which org it belongs to). The site's
   product pages read this registry. The local `product.json` below
   stays the laptop's copy of the same pointers.

### `~/.proto/<product>/product.json`

```jsonc
{
  "schemaVersion": 1,
  "product": "acme",
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
   tools/cdp/chrome.mjs` (kit tools resolve from
   `${CLAUDE_PLUGIN_ROOT}` when running as the installed proto
   plugin, else the proto-kit checkout) — its profile lives at
   `~/.proto/chrome`, so logins persist across sessions and reboots;
   the login is one-time.
2. Ask the user to open their product in that window and log in —
   including the snippet's reference page when there is one.
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
   your product's agent.** This very session (in the terminal or the
   Claude Code desktop app) is what receives the site's commands;
   continue into the product-agent protocol. Closing it doesn't lose
   anything — commands queue in the feed — but nothing runs until a
   session picks the protocol up again.
