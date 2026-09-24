---
name: create-prototype
description: Build a prototype from your product's own code. A prototype is one screen or flow of your product, built in its own workspace with your design system, with preview states, variant sets, and comment markers, ready to review in Proto. Use when the user asks to create or build a prototype, mock up a flow or screen from their product, or explore design directions on a page.
---

# Create a prototype

A prototype is an atomic, framework-native slice of the user's app: a
standalone vanilla Vite app importing their real design system. Naked:
nothing Proto-visible inside it except the rig, the invisible package
that syncs state to the URL and speaks to the Frame. The Frame (the
Proto web app) wraps it with the variants sidebar, comment pins,
and state map; your job is only the app itself.

## The brief

You need three things before scaffolding; ask only for what's missing:

- **A short, specific title** — keep prototype names brief and to the
  point, usually 2–5 words that identify the screen or flow. Avoid
  filler such as "prototype," "concept," or "exploration." Good examples:
  "Checkout Review," "Invite Teammates," "Empty Inbox," and "Billing
  Settings." Avoid names like "New Checkout Flow Prototype" or "Settings
  Page Design Exploration." Kebab-case the title into the slug (lowercase
  letters, digits, hyphens; it becomes the subdomain label, so pick
  something a person could read aloud).
- **What it should show** — the feature, flow, or screen, and what is
  being explored or decided.
- **A live source URL** when the prototype replicates an existing page:
  the page in the user's product it must look like.

A brief may also carry **reference HTML** (a snapshot the site's
dialog captured): use it to map structure and copy, but the live page
wins on any disagreement, and never paste it into the prototype at
runtime.

## The gallery shows the build

Before scaffolding, put a loading card in the user's gallery: call
`begin_prototype_build { codebase, slug, title, owner }` (owner is
config.json's `account.user`) and keep the brief id it returns. One
guard: when this build was started by a website brief, you already
have a brief id: use that one and do not call
`begin_prototype_build` again.

Report progress on that brief id at the checkpoints, each message
one plain sentence a non-engineer can read: `started` before any
slow work, `building` when workspace work begins, `serving` when the
serve flow starts, and `failed` or `needs-input` whenever that is
the truth. Registration, inside the serve skill, flips the brief to
done.

## Where it lives

Scaffold `~/.proto/<codebase>/prototypes/<slug>/` by copying the
workspace template **matching the source repo's framework**. Read the
codebase's `package.json`: `vue` → `template/workspace-vue/`, otherwise
(react, or no source repo) → `template/workspace-react/`. The
prototype is a framework-native slice; a React mock of a Vue product
isn't one. Then make it this prototype's own:

1. `package.json` `name`, `index.html` `<title>`, and
   `public/prototype.json` `name` → the slug.
2. Pick a free port (one prototype per port; check the codebase's other
   workspaces) and set it in **both** `vite.config.ts` and
   `prototype.json`: they must agree, the Frame reads the manifest.
3. Pre-npm: the rig resolves via the `PROTO_PACKAGES` env var (path to
   a proto checkout's `packages/` dir, recorded in
   `~/.proto/config.json`). Vite reads it in the template's config,
   and `tsc` needs the same entries written into `tsconfig.json`
   `paths`: the adapter (`@proto/rig` → `<packages>/rig/src/index.tsx`
   for React, `@proto/rig-vue` → `<packages>/rig-vue/src/index.ts` for
   Vue), plus `@proto/rig-core` → `<packages>/rig-core/src/index.ts`
   (the adapters bare-import it) and `@proto/wire` →
   `<packages>/wire/src/index.ts`. Don't vendor the rig, don't add it
   to package.json: once the packages publish to npm they become
   plain dependencies and both the alias block and the paths
   disappear.
4. `pnpm install` (standalone: never inside a git checkout, never a
   workspace package of one).

`modern-screenshot` stays a dependency of every workspace: the rig
lazy-imports it from the prototype's own node_modules for comment
capture. Removing it breaks comment screenshots silently.

## The live URL is the visual source of truth

When there is a source URL, the prototype must look like that page,
not like the source code's idea of it, not like your memory of it.

1. Confirm the URL is reachable first. If it doesn't load (auth wall,
   404, connection refused), **stop and tell the user**: never invent
   the page from memory or source alone. If it's behind their login,
   read it through their own Chrome over CDP exactly as the
   import-design-system skill does (attach, never steal focus).
2. Walk the page before building: hover the controls, open the menus,
   dropdowns, sheets. Capture what each interaction reveals. The
   resting screenshot is not the page.
3. Find the matching page in the source repo and read its
   layout and components: the source explains mechanisms (why a
   toolbar wraps, what an active state looks like). Copy render
   structure and mechanisms into the prototype; never import the
   user's app code at runtime.

"Match" means: same chrome, layout, type, color, copy, control
variants, and states. Semantic tokens and components from the
imported library, no guessed hex, no simplified chrome, no invented
alternate layout.

Page-level fidelity is THIS skill's job (the import extracts the
system; it never rebuilds pages). When a page must be matched
closely, use the CDP toolkit (`tools/cdp/`) with the reading
discipline in the import-design-system skill and the traps in
`docs/cdp-traps.md`: read values, copy mechanisms, verify rects
before pixels, at whatever fidelity the prototype's purpose
actually needs.

## Build from their design system

Before writing UI, open the codebase's library
(`~/.proto/<codebase>/library/`) and map each region of the page to
extracted components and tokens. Reuse what the import produced; when
a component the page needs is missing from the library, build it
faithfully from source + live page (and note it as an import gap):
don't invent a parallel look.

**Wire the source's CSS system into the workspace**: the template
ships bare CSS on purpose (it doesn't know your product). Read how the
source styles itself and reproduce that chain:

- Tailwind source (the common case): add `tailwindcss` +
  `@tailwindcss/vite` to the workspace, register the plugin in
  `vite.config.ts`, and import the product's theme/token layer in
  `styles.css` before your own rules. The goal is that the product's
  utility classes and tokens resolve identically in the prototype.
- Plain CSS/custom-property systems: import the token stylesheet(s)
  (from the library import or copied from source) at the top of
  `styles.css`.

Either way, verify a chromatic token early: one element using a brand
color must render the source's hue, not a default. Catching a
dead style chain before building the page is minutes; after, hours.

Mock data by default: typed constants in the prototype, realistic copy
(real-sounding names, plausible timestamps: the inbox example's
messages, not "Item 1"). Real backend data only when the user asks.

## Component markers: mandatory

Every visually coherent component's root element carries a kebab-case
`data-proto-id`. The Frame's comment mode hit-tests these markers for
the selector and anchors comments to them.

- Coherent component, not every div: header, message-list,
  message-row, yes; a wrapper whose only job is to hold another div,
  no. List rows repeat the same id; that's correct.
- Ids are **anchor keys**: comments people leave are pinned to them.
  Once a prototype has been served, renaming an id orphans its
  comments: extend, don't rename. Ids ported from an existing
  registry stay verbatim (dot-separated kebab segments like
  `project-shell.product-sidebar` are valid) for the same reason.
- Vendored third-party code (a copied design-system package slice,
  say) lives **outside `src/`**: `vendor/` at the workspace root.
  Everything under `src/` is prototype-authored and must be fully
  marker-covered; the checker enforces exactly that line.
- `node tools/verify-markers.mjs <workspace>` (resolve kit tools from the
  installed host's `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, or
  `CURSOR_PLUGIN_ROOT`; otherwise use the root above this skill's
  `skills/` directory) must pass before you're
  done: it fails any component-rendering file with no markers and any
  non-kebab id, and prints the id inventory. Read it and check it
  names the page's real anatomy.

## Preview states

Before building UI, list every distinct mode a reviewer should reach:
tabs and steps, empty/loading/error branches, open overlays worth
jumping to, view toggles. Each becomes a state in `prototype.json`
(id, title, one-line description, `parent` for branches of a base
state) and a branch in the code via `usePreviewState`.

- The rig owns URL sync: every state is addressable as `?state=<id>`,
  and copy-pasting a URL must reproduce the exact mode. You never
  touch the URL yourself: derive UI from the hook, register ids in
  the manifest, ids in both places must match.
- Wire the product's own controls to move between states (a Retry
  button leaves the error state; emptying the list enters the empty
  state): reviewers should be able to use the prototype, not only
  the Frame's state picker.
- Hover and focus are CSS, not states.

## Design explorations

When the brief asks "which direction?", add a variant set under
`variantSets` in `prototype.json`: the `component` it varies, 2–4
`variants` (id, title, a `note` saying what the direction is for), the
`default`, the `baseline` (the UI as it exists today, so reviewers can
always compare against current reality), and an `overview` framing the
question being decided. Drive the code with `useVariant`.

Ground variants in reality: for each direction, find a real product
that does it well, capture or draw a small reference image into
`public/references/`, and register it under `references` with a note
saying what to look at and which variant it informs. A variant without
a reference is a guess with styling.

### Static variant previews (mandatory)

Every variant, including the baseline, gets a lightweight SVG preview.
Put it at `public/previews/<variant-id>.svg` and register these fields on
the variant in `prototype.json`:

```json
{
  "id": "compact-card",
  "title": "Compact card",
  "preview": "/previews/compact-card.svg",
  "previewBackground": "#f8f7f3"
}
```

The SVG is a review thumbnail of the **varied component only**, not a
screenshot or illustration of the full page:

- Draw only the component rooted at the variant set's `component`
  marker. Never include app chrome, the page heading, surrounding
  sections, decorative page art, or unrelated context.
- Preserve the component's recognizable hierarchy, copy, color, borders,
  and major shapes. It may simplify fine detail, but directions must be
  distinguishable without loading the prototype.
- Use a `viewBox` around the component with a safe area on every edge.
  Horizontal padding is mandatory: leave at least 6% of the component
  width on both sides (and at least 24 viewBox units). Leave at least 16
  units above and below. Rules, bands, cards, and other full-width shapes
  must stop inside this safe area, never at the SVG edge.
- Fill the entire SVG viewBox with the actual page canvas color behind
  the component. Do not leave the SVG transparent. Set
  `previewBackground` to that exact resolved color too, so the Frame's
  `object-contain` letterbox matches the prototype rather than the
  Frame's light or dark card color.
- Keep the asset standalone: inline shapes and resolved colors, no
  scripts, animation, external images, remote fonts, or runtime CSS.
  Prefer SVG geometry over Unicode symbols; malformed text bytes can
  invalidate the whole asset.
- Give each changed asset a new filename or versioned URL while iterating;
  served prototype assets may be cached.

Open every generated SVG directly once and confirm it renders before
serving. Visual inspection must prove the component is isolated, padded,
and on the right background.

## Verify, then stop

1. `pnpm typecheck` and `node tools/verify-markers.mjs <workspace>` pass.
   Open every generated preview SVG directly and reject malformed,
   transparent, unpadded, or full-page assets before serving.
2. Paired screenshots against the live source URL: the resting page
   plus the 2–3 most important captured interactions. Read the pairs,
   list mismatches, fix the obvious ones, re-shoot once. **Two rounds
   total, then stop**: remaining mismatches get reported to the
   user, not iterated on forever.
3. Reload the app at `?state=<id>` for each registered state and
   confirm the right mode renders.
4. **Hand off to the serve skill, which registers the prototype and
   provisions its tunnel, in that order.** Registration
   (`register_prototype` with `{ codebase, slug, title, owner }`,
   owner = config.json's `account.user`) happens inside the serve
   skill, never here: the row must exist before `provision_tunnel`
   can store the prototype's address on it, and serving is one
   skill's job. The site never loads a live address before the row
   has one and a fresh heartbeat, so an early tile shows a waiting
   state rather than poisoning anyone's resolver. `register_prototype`
   upserts on (codebase, slug), so re-registering after a title
   change is correct and expected; an unknown-owner error means
   `account.user` is wrong: fix it in setup, not here. Registering
   also flips the build's brief to done, closing the gallery's
   loading card.

Serving the prototype (dev server + tunnel + registration) is the
serve skill's job. Don't provision tunnels, don't publish, don't
commit anything into the user's repos: the workspace lives outside
them on purpose. When it works locally, continue into the serve
skill; the user should hear about the prototype once it is reachable,
not before.
