---
name: setup
description: Set up Proto on this machine and link a project — account credentials into ~/.proto/config.json, find the product's source repo from whatever scraps the user gives, scaffold the project's ~/.proto/<project>/ home. Use when installing Proto, connecting a new product, or when other Proto skills find no config.json or project.json.
---

# Setup

Two scopes, both idempotent: the **machine** (once — config.json,
prerequisites) and a **project** (once per product being prototyped —
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

## Project

A project is one product being prototyped: `~/.proto/<project>/`,
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

### `~/.proto/<project>/project.json`

```jsonc
{
  "schemaVersion": 1,
  "project": "acme",
  "source": {
    "path": "/abs/path/to/acme-web",   // the checkout
    "remote": "git@github.com:acme/acme-web.git",
    "liveUrl": "https://…"             // where the product runs, if known —
  },                                   //  the import skill wants it
  "createdAt": "2026-09-19T…"
}
```

### Library scaffold

Copy `template/library/` → `~/.proto/<project>/library/` (skip if it
already has a manifest with content). The import-design-system skill
fills it; the serve skill serves it.

## Verify

- `config.json` and `project.json` parse; `source.path` exists and its
  `package.json`/remote match the product.
- The app is reachable: `GET <app>/api/session` responds (any status —
  you're checking the origin, not logging in).
- `cloudflared --version` runs.

Report what you set up, what you found vs. were told, and anything you
skipped because it already existed.
