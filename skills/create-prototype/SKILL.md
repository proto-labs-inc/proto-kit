---
name: create-prototype
description: Scaffold and build a Proto prototype — an atomic, framework-native slice of the user's app in its own workspace, with preview states, design explorations, and comment markers. Use when the user asks to create/build a prototype, mock up a flow or screen from their product, or explore design directions on a page.
---

# Create a prototype

A prototype is an atomic, framework-native slice of the user's app: a
standalone vanilla Vite app importing their real design system. Naked —
nothing Proto-visible inside it except the rig, the invisible package
that syncs state to the URL and speaks to the Frame. The Frame (the
Proto web app) wraps it with the explorations sidebar, comment pins,
and state map; your job is only the app itself.

## The brief

You need three things before scaffolding; ask only for what's missing:

- **A title** — kebab-case it into the slug (lowercase letters,
  digits, hyphens; it becomes the subdomain label, so pick something a
  person could read aloud).
- **What it should show** — the feature, flow, or screen, and what is
  being explored or decided.
- **A live source URL** when the prototype replicates an existing page
  — the page in the user's product it must look like.

## Where it lives

Scaffold `~/.proto/<project>/prototypes/<slug>/` by copying
`template/workspace/`, then make it this prototype's own:

1. `package.json` `name`, `index.html` `<title>`, and
   `public/prototype.json` `name` → the slug.
2. Pick a free port (one prototype per port; check the project's other
   workspaces) and set it in **both** `vite.config.ts` and
   `prototype.json` — they must agree, the Frame reads the manifest.
3. Pre-npm: the rig resolves via the `PROTO_PACKAGES` env var (path to
   a proto checkout's `packages/` dir, recorded in
   `~/.proto/config.json`) — vite reads it in the template's config,
   and `tsc` needs the same two entries written into `tsconfig.json`
   `paths` (`@proto/rig` → `<packages>/rig/src/index.tsx`,
   `@proto/wire` → `<packages>/wire/src/index.ts`). Don't vendor the
   rig, don't add it to package.json — once it publishes to npm it
   becomes a plain dependency and both the alias block and the paths
   disappear.
4. `pnpm install` (standalone — never inside a git checkout, never a
   workspace package of one).

`modern-screenshot` stays a dependency of every workspace: the rig
lazy-imports it from the prototype's own node_modules for comment
capture. Removing it breaks comment screenshots silently.

## The live URL is the visual source of truth

When there is a source URL, the prototype must look like that page —
not like the source code's idea of it, not like your memory of it.

1. Confirm the URL is reachable first. If it doesn't load (auth wall,
   404, connection refused), **stop and tell the user** — never invent
   the page from memory or source alone. If it's behind their login,
   read it through their own Chrome over CDP exactly as the
   import-design-system skill does (attach, never steal focus).
2. Walk the page before building: hover the controls, open the menus,
   dropdowns, sheets. Capture what each interaction reveals. The
   resting screenshot is not the page.
3. Find the matching page in the project's source repo and read its
   layout and components — the source explains mechanisms (why a
   toolbar wraps, what an active state looks like). Copy render
   structure and mechanisms into the prototype; never import the
   user's app code at runtime.

"Match" means: same chrome, layout, type, color, copy, control
variants, and states — semantic tokens and components from the
imported library, no guessed hex, no simplified chrome, no invented
alternate layout.

## Build from their design system

Before writing UI, open the project's library
(`~/.proto/<project>/library/`) and map each region of the page to
extracted components and tokens. Reuse what the import produced; when
a component the page needs is missing from the library, build it
faithfully from source + live page (and note it as an import gap) —
don't invent a parallel look.

Mock data by default: typed constants in the prototype, realistic copy
(real-sounding names, plausible timestamps — the inbox example's
messages, not "Item 1"). Real backend data only when the user asks.

## Component markers — mandatory

Every visually coherent component's root element carries a kebab-case
`data-proto-id`. The Frame's comment mode hit-tests these markers for
the selector and anchors comments to them.

- Coherent component, not every div: header, message-list,
  message-row — yes; a wrapper whose only job is to hold another div —
  no. List rows repeat the same id; that's correct.
- Ids are **anchor keys**: comments people leave are pinned to them.
  Once a prototype has been served, renaming an id orphans its
  comments — extend, don't rename.
- `node tools/verify-markers.mjs <workspace>` must pass before you're
  done: it fails any component-rendering file with no markers and any
  non-kebab id, and prints the id inventory — read it and check it
  names the page's real anatomy.

## Preview states

Before building UI, list every distinct mode a reviewer should reach:
tabs and steps, empty/loading/error branches, open overlays worth
jumping to, view toggles. Each becomes a state in `prototype.json`
(id, title, one-line description, `parent` for branches of a base
state) and a branch in the code via `usePreviewState`.

- The rig owns URL sync: every state is addressable as `?state=<id>`,
  and copy-pasting a URL must reproduce the exact mode. You never
  touch the URL yourself — derive UI from the hook, register ids in
  the manifest, ids in both places must match.
- Wire the product's own controls to move between states (a Retry
  button leaves the error state; emptying the list enters the empty
  state) — reviewers should be able to use the prototype, not only
  the Frame's state picker.
- Hover and focus are CSS, not states.

## Design explorations

When the brief asks "which direction?", model it as an exploration in
`prototype.json`: the `component` it varies, 2–4 `variants` (id,
title, a `note` saying what the direction is for), the `default`, the
`baseline` (the UI as it exists today, so reviewers can always compare
against current reality), and an `overview` framing the question being
decided. Drive the code with `useVariant`.

Ground variants in reality: for each direction, find a real product
that does it well, capture or draw a small reference image into
`public/references/`, and register it under `references` with a note
saying what to look at and which variant it informs. A variant without
a reference is a guess with styling.

## Verify, then stop

1. `pnpm typecheck` and `node tools/verify-markers.mjs <workspace>` pass.
2. Paired screenshots against the live source URL — the resting page
   plus the 2–3 most important captured interactions. Read the pairs,
   list mismatches, fix the obvious ones, re-shoot once. **Two rounds
   total, then stop** — remaining mismatches get reported to the
   user, not iterated on forever.
3. Reload the app at `?state=<id>` for each registered state and
   confirm the right mode renders.

Serving the prototype (dev server + tunnel) is the serve skill's job.
Don't provision tunnels, don't publish, don't commit anything into the
user's repos — the workspace lives outside them on purpose. Stop after
it works locally and tell the user what to look at.
