---
name: create-prototype
description: Build a new prototype from your product's own code, optionally with its initial variant sets. Use when the user asks to create or build a new prototype or mock up a new flow or screen. Do not use for variant work in an existing prototype; use create-variant-set, add-variants, or edit-variant instead.
---

# Create a prototype

A prototype is an exact copy of one screen of the user's product with
the brief's change built on top of it: a standalone Vite app in
`~/.proto/<codebase>/prototypes/<slug>/`, naked except for the rig (the
invisible package that syncs state to the URL and speaks to the Frame).
The tools copy the page; you write only the change.

All `tools/…` paths resolve from the kit root: the installed plugin
root the host exposes (`PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`,
`CURSOR_PLUGIN_ROOT`), otherwise the folder above this skill's
`skills/` directory. Run every kit tool with the node the kit runs on.

## The runbook

1. **Brief.** The site or a copied prompt hands you fields: `codebase`,
   `description` (may be empty when `contextUrl` carries the brief),
   `contextUrl` (a document, issue or notes link, resolved below),
   `referenceUrl` (the live screen to copy), `referenceHtml` (structure hints; the live
   page wins), `useRealData` (false means mock realistic data). A brief
   whose run is `rebuild-section` goes to "Rebuilding one section". Resolve
   `contextUrl` before scaffolding: use a callable connected connector when
   available. When a matching connector plugin is available but not installed
   or connected, ask whether the user wants to install or connect it; if they
   decline, read the link in a browser. Only go straight to the browser when
   neither a callable connector nor a matching installable plugin exists.
2. **Title and slug.** From the brief's content: 2 to 5 words naming the
   screen or flow, never from a URL, path or issue key, never "New
   prototype", no filler like "prototype" or "concept". Kebab-case it
   into the slug (it becomes the subdomain label). Creation is isolated and
   additive: the slug must be unused both at
   `~/.proto/<codebase>/prototypes/<slug>/` and in the codebase's registered
   gallery prototypes. Either match is a collision; keep the title and try
   `<slug>-2`, then `<slug>-3`, checking both places each time. If the gallery
   cannot be checked read-only, stop with `needs-input` rather than risk an
   upsert. Never update, reuse, replace, re-register, restart, republish, or
   otherwise mutate an existing prototype during creation.
3. **Brief id.** A website brief already has one: use it. Otherwise
   `begin_prototype_build { codebase, slug, title }` returns it; the
   gallery shows a loading card from here. `report_progress
   { briefId, status: "started" }` before any slow work.
4. **Copy the page**, one command. The live URL is the visual source of truth.
   Before opening a browser or tab, inspect readable existing tabs in the
   in-app browser, the user's Chrome, and Proto Chrome on port 9333. Prefer an
   exact `referenceUrl` match, then the same path, then the same origin, and
   reuse a signed-in tab that provides the DOM and capture access needed. Only
   start Proto Chrome or open a duplicate after those checks; ask the user to
   sign in only when no readable context has a usable session. If the URL still
   cannot be read, stop rather than inventing the page from source or memory.
   `node tools/proto-build.mjs <briefId> --codebase <id> --page
   <referenceUrl substring> --slug <slug> --title "<title>"`.
   It reads the page (styles, variables, fonts, images: everything the
   change needs, in the build folder), sends the title, drafts the
   curation and **stops once**, printing the leaves and sections with
   their draft names. Fix names that read as "Group", "Block", "Text" or
   "part-nN" in the printed `curation.json` (the `raw` and `text` fields
   say what the part is; the marker follows the name, kebab-case) and
   leave the rest. Names become `data-proto-id` markers, which are
   comment anchors for the prototype's life, so this is the one review
   worth an agent turn. Then run **the same command again**: it names
   the tree, scaffolds the workspace, replicates every leaf in parallel
   lanes, composes `src/App.tsx`, checks the page, and prints the parts
   list (also at `<build>/parts.json`): each part's node id, name,
   marker, files under `src/parts/<slug>/`, whether it came from the
   library, its check's status, its rect and its section. Every event
   the site needs (phases, queued, pass, matched, composing) is sent by
   the tools; you send none of them yourself. `--accept-curation` skips
   the stop when the draft names are already right.
5. **Serve early.** The dev server the copy used has stopped; start the
   serve skill's steps 1 to 4 now (register, provision the tunnel, write
   the run spec, `supervise.mjs start`), in that order, and do not verify
   through the edge yet: the tunnel connects while you write the change.
   `report_progress serving` comes later, at step 10.
6. **Parts left to fix** (`toFix` in the parts list, usually a few): one
   `proto:part-fixer` subagent per part, all in parallel, with the part
   brief below. Do not pass a model. Carry on with step 7 while they run.
7. **Write the change.** Edit only the parts the brief is about, from the
   parts list and the copied files: never re-read the live page with
   ad-hoc scripts, the read has everything. A part from the library is a
   library component copied into `src/parts/`; edit the copy. Send
   `build-stream.mjs focus <briefId> --codebase <id> <nodeId>` when you
   start on a part, so the site shows which one.
   - **Preview states**: every distinct mode a reviewer should reach
     (tabs and steps, empty/loading/error branches, overlays, toggles)
     is a state in `public/prototype.json` (id, title, one-line
     description, `parent` for branches) and a branch in the code via
     `usePreviewState` from `@proto/rig`; the ids in both must match. The
     rig owns the URL (`?state=<id>`); wire the product's own controls to
     move between states. Hover and focus are CSS, not states.
   - **Variants**: step 8.
   - Mock data reads as real (real names, real-looking numbers and
     dates); the source app's live data only when `useRealData` is true.
   - Carry both imported themes into the prototype. The rig sets
     `data-proto-theme="light|dark"`, the conventional `.dark` class, and
     `color-scheme` on the root before render. Bridge that contract to the
     product's existing theme mechanism and use its light and dark token
     collections; never manufacture dark colors by inversion.
8. **Variants in parallel.** Decide one or two decisions the brief
   supports a real choice on (layout, hierarchy, interaction pattern,
   density); none when it supports none. For each, one command writes
   the skeleton:
   `node tools/variant-set.mjs <workspace> <marker> --title "<set>"
   --variants "<id>=<Title>|<note>;<id>=<Title>|<note>" --default <id>
   --baseline current=Current --overview "<the question>" --slot <class>`
   where `<marker>` is the `data-proto-id` of the part the set varies
   and `<class>` its slot in App.tsx (`className={styles["partNN"]}`).
   It writes the manifest entry (`status: "building"`), the switch
   `src/variants/<marker>/index.tsx` on `useVariant`, one stub per
   variant, and frees the slot's pinned height. You replace the part in
   App.tsx with the switch, the part itself as its baseline:
   `<MarkerVariants className={styles["partNN"]} baseline={<Part className={styles["partNN"]} />} />`.
   Then one `proto:variant-builder` subagent per variant, all in
   parallel, with the variant brief below; do not pass a model. Mobbin
   references are not gathered in a build: the baseline is the reference.
9. **Check, as tools.** When the units are back:
   - `pnpm typecheck` in the workspace and `node tools/verify-markers.mjs <workspace>`.
   - `node tools/check-states.mjs <workspace> --brief <briefId> --codebase <id>`:
     every state and every variant loaded headless; blank renders,
     console errors, a set's marker missing from its view, parts drawn
     outside their parents or over siblings, and the untouched parts
     against the read (moved, resized, pixel clusters outside the
     change). Add `--changed <marker,marker>` for parts you edited
     outside a variant set (the sets' components are known). Fix what it
     names, run it again; two rounds, then report what remains. It sends
     the pass and matched events for the changed parts.
   - `node tools/previews.mjs <workspace> --brief <briefId> --codebase <id>`:
     the variant previews from real renders, into the manifest, and the
     set's `status` cleared.
10. **Serve.** Continue in the serve skill at step 5 (verify through the
    edge, publish, report); `build-stream.mjs phase <briefId> --codebase
    <id> serving "<one sentence>"` and `report_progress serving` as it
    starts. When the prototype is reachable and published, close the
    build: `report_progress { briefId, status: "done", prototypeSlug:
    "<slug>", message: "<one sentence>" }`. Registration closes only a
    build begun with `begin_prototype_build`; a website brief stays open,
    and its gallery tile says the agent stopped reporting, until this
    call. Tell the user once the prototype is reachable, not before.
    Never commit anything into the user's repos.

Blocked at any step: `build-stream.mjs question <briefId> --codebase
<id> "<question>"` and `report_progress needs-input`; a failure is
`report_progress failed` with one plain sentence.

## The part brief

> Fix the part `<slug>` (`<name>`, node `<nodeId>`) of build `<briefId>`
> in codebase `<codebase>` so it matches the reference page. Its folder
> is `<workspace>/src/parts/<slug>/` (`<Name>.tsx`, `<Name>.module.css`,
> `component.json`); the build folder is
> `~/.proto/<codebase>/run/builds/<briefId>/`. What differs: `<the
> part's differs entry>`. Pass pictures are in `<build>/checks/<slug>/`
> (`<n>-live.png` the product, `<n>.png` ours, `<n>-diff.png` the
> difference). Read the value that differs from `<build>/read.json`
> (the element's computed style; `tree.json` names the element index),
> never from the live page. Fix it in the module or stylesheet, then run
> `node <kit>/tools/check-part.mjs <briefId> --codebase <codebase>
> <slug>`. At most six checks; write only in the part's folder. Report
> the last check's verdict and mismatch per state.

## The variant brief

> Write the `<id>` variant ("<Title>": <note>) of the "<set title>" set
> in the Proto prototype at `<workspace>`. Its files are
> `src/variants/<marker>/<id>.tsx` and `<id>.module.css` (stubs exist;
> replace them). The part it varies is the copy at
> `src/parts/<slug>/<Name>.tsx` and `.module.css`: keep its data (names,
> numbers, copy) and the product's values (its colours, type and spacing;
> `src/tokens.css` holds the page's custom properties), rearranged as the
> direction says. The root keeps `data-proto-id="<marker>"`; every
> coherent piece inside carries its own kebab-case `data-proto-id`. The
> component takes `{ className?: string }` and puts it on the root. No
> new dependencies; touch no other file. Run `pnpm typecheck` in the
> workspace before finishing. Report the files written and the last
> typecheck's result.

## Component markers

Every visually coherent component's root element carries a kebab-case
`data-proto-id` (dot-separated kebab segments are valid for ids ported
from a registry). The Frame's comment mode hit-tests them, and comments
are pinned to them: once served, renaming an id orphans its comments;
extend, do not rename. List rows repeat one id. Vendored third-party
code lives outside `src/` (`vendor/`); everything under `src/` is
prototype-authored and marker-covered; `verify-markers.mjs` enforces
exactly that line and fails a non-kebab id.

## Images and other public files

`public/` ships to the build root and a published build lives under a
path, so reference files against the build's base:
`<img src={`${import.meta.env.BASE_URL}portraits/soleio.jpg`} />`. A
root-absolute `/portraits/x.jpg` works in dev and dies published;
`publish.mjs` refuses such a build. Paths in `public/prototype.json`
are build-relative without a leading slash (`previews/x.png`,
`references/x.png`); `previews.mjs` writes them that way.

## Where it lives

`scaffold.mjs` (inside `proto-build.mjs`) creates the workspace from
the template matching the source repo's framework (`vue` in its
`package.json` → `template/workspace-vue/`, else
`template/workspace-react/`): the slug in `package.json`, `index.html`
and `public/prototype.json`; a free port in `vite.config.ts` and
`prototype.json` (they must agree); the rig's source paths in
`tsconfig.json` (pre-npm, via `PROTO_PACKAGES` from `~/.proto/config.json`);
the page's tokens, fonts and body base in `src/`; Tailwind when the
source uses it; `pnpm install` from the shared store. Never vendor the
rig or add it to `package.json`; `modern-screenshot` stays a dependency
of every workspace (the rig lazy-imports it for comment capture).
`docs/build-read.md` describes the build folder.

## Rebuilding one section

A brief whose run is `rebuild-section` is a change asked from the
Frame's element picker: `get_brief` gives the prototype
(`prototype_slug`), the component (`section`, its `data-proto-id`) and
the change (`description`, the Frame's full edit prompt, scoped to that
component and its variant). The Frame has frosted the component over.
Report `started`, make the change in the prototype's workspace (the
running dev server shows it as you save), run `check-states.mjs` and,
for a variant, `previews.mjs`, then `report_progress done`. When the
prototype came from a streamed build (`parent_brief_id` is set), run
those two with `--brief <parent> --codebase <id>` so the build's stream
shows the change: the node is the one whose `marker` is the section.
