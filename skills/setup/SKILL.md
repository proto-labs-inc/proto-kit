---
name: setup
description: Set up Proto on this machine and link a product — account credentials into ~/.proto/config.json, find the product's source repo from whatever scraps the user gives, scaffold the product's ~/.proto/<product>/ home. Use when installing Proto, connecting a new product, or when other Proto skills find no config.json or product.json.
---

# Setup

Two scopes, both idempotent: the **machine** (once — config.json,
prerequisites) and a **product** (once per product being prototyped —
source link, library scaffold). Re-running setup repairs; it never
clobbers working state.

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
  "account": { "user": "ooj", "org": "proto-labs" },
  "auth": { "kind": "shared-secret", "secret": "…" },
  "packages": "/abs/path/to/proto/packages",   // optional, pre-npm: the rig's source
  "createdAt": "2026-09-19T…"
}
```

**The auth step is a swappable slot.** Today there is no device-link
flow, so `auth` records the shared provisioning secret
(`PROTO_PROVISION_SECRET`, from a proto checkout's `.env` via
`pnpm env:pull`, or handed over by Proto). When device auth ships,
this step — and only this step — is replaced; it will write a
different `auth.kind`. Everything downstream reads `auth` opaquely
and sends `Authorization: Bearer <auth.secret>`; nothing else may
depend on the auth kind.

`chmod 600` the file — it holds a credential.

### Connect the proto MCP server

The MCP server is how every kit skill talks to the cloud (tunnels,
registration, source registry, comments). Add it to the user's Claude
Code as soon as config.json exists — the URL comes from `app`, the
header from `auth`; never a hardcoded domain:

```
claude mcp add --transport http proto <app>/api/mcp \
  --header "Authorization: Bearer <auth.secret>"
```

Then confirm with the `whoami` MCP tool: it reports the auth mode,
org, and grants. A connected server whose `whoami` fails means the
credential is stale — redo the auth step above.

## Product

A product is one product being prototyped: `~/.proto/<product>/`,
slug-named after the product (lowercase, digits, hyphens).

### Find the source from scraps

You need the product's repo checked out locally. The user rarely hands
you an absolute path — they give you scraps: a repo or org name, a PR
link, a live URL, "the acme frontend". Work with whatever arrived:

1. **Search before asking.** Look for checkouts in the obvious places
   (`~/Projects`, `~/code`, `~/src`, `~/dev`, `~/work`, one or two
   levels deep for `.git`), matching directory names, `package.json`
   names, and git remotes against the scraps. A PR/issue link names
   its repo (`gh pr view <url>` does too); a live URL's domain often
   names the org.
2. **Confirm with evidence, don't interrogate.** When you find a
   candidate, present it with why you believe it ("`~/work/acme-web`,
   remote `github.com/acme/acme-web` — this one?"). One yes/no beats
   three open questions.
3. **Never ask two unanswerable questions in a row.** Every question
   must be answerable from what the user obviously knows, and must
   carry your best guess so a "yes" is enough. If you struck out
   locally, offer the concrete next move: "I can clone
   `acme/acme-web` — where do you keep code?"
4. **Clone if it isn't local** (`gh repo clone`), where they keep
   code.
5. **Record it in the cloud** once confirmed: the
   `set_product_source` MCP tool with
   `{ product, sourcePath, repoRemote }` — the site's product pages
   read this registry. The local `product.json` below stays the
   laptop's copy of the same pointers.

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

Report what you set up, what you found vs. were told, and anything you
skipped because it already existed.
