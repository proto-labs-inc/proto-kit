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

## Authorization

A request to create or build a prototype authorizes this runbook end to
end, including registering the new prototype, provisioning its public
address, starting its tunnel, and uploading its permanent snapshot. These
are expected completion steps, not a separate expansion of scope. Do not
ask the user for an additional permission merely to serve or publish the
prototype created by the request.

This does not bypass a confirmation that the host or a tool itself requires.
When such a confirmation is mandatory, present that exact confirmation at
the action boundary and resume the same build after it is approved; do not
turn it into a separate design decision or an open-ended Proto question.

All `tools/…` paths resolve from the kit root: the installed plugin
root the host exposes (`PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`,
`CURSOR_PLUGIN_ROOT`), otherwise the folder above this skill's
`skills/` directory. Run every kit tool with the node the kit runs on.

## Website handoffs and resumes

When the user pastes a website work prompt with a `briefId`, read
`docs/work-handoff.md` first. For create-prototype, prepare fetches get_brief and
validates inputs/action/target/status. Do not repeat those checks manually.
Other actions still fetch their brief and route to their matching skill. Keep
identity, action and target top-level and request content in brief.inputs.

For an explicit resume of this same brief, verify the codebase, creator,
prototype slug, and saved build checkpoint agree before reusing its workspace.
Then continue the same command without `--again`; do not re-create or overwrite
completed work. The unused-slug rule below applies to new creation, not a
verified same-brief resume. Missing or contradictory state requires input.

## Progress reporting

Follow `docs/build-progress.md`. The runner owns stage progress and completion;
report context review and focused edits while doing agent work. Preserve the
brief ID, required questions, completed requests and verified checkpoints.

## The runbook

1. **Brief.** The site or a copied prompt hands you fields: `codebase`,
   `description` (may be empty when `contextUrl` carries the brief),
   `contextUrl` (a document, issue or notes link, resolved below),
   `referenceUrl` (source-route context only), `referenceImage` (required full-page
   screenshot; the visual source of truth), `useRealData` (false means mock realistic data). A brief
   whose run is `rebuild-section` goes to "Rebuilding one section". Resolve
   `contextUrl` before scaffolding: use a callable connected connector when
   available. When a matching connector plugin is available but not installed
   or connected, ask whether the user wants to install or connect it; if they
   decline, read the link in a browser. Only go straight to the browser when
   neither a callable connector nor a matching installable plugin exists.
2. **Prepare.** Choose a meaningful 2 to 5 word title when the request is already
   available. Otherwise omit --title and follow the runner result. For a
   saved website request, run:
   `node tools/proto-build.mjs prepare <briefId> --codebase <id> --title "<title>"`.
   The runner verifies identity, team, capabilities, saved source path and brief;
   atomically claims a slug; preserves the uploaded screenshot; and scaffolds the
   workspace. Do not inspect the gallery, choose numbered slugs, update a
   compatible plugin, or repeat its mechanical steps yourself. For a direct-chat
   request without a brief, call begin_prototype_build once with codebase, slug,
   title, description, useRealData, referenceUrl and referenceImage. Keep its ID
   and use the same runner thereafter. A slug-conflict requires a numbered slug;
   never reuse another request. Both references are required before copying.
3. **Follow the result.** `needs-agent` describes the implementation work;
   `needs-input` needs a real answer in this conversation; `retryable-error`
   preserves completed work for another invocation; `done` means this request
   already completed. Missing source/credentials go to setup for this existing
   codebase. Never create a replacement request or codebase.
4. **Inspect the reference.** Use only the saved screenshot for appearance and
   the URL path to search local source. Never visit the source URL, inspect its
   browser tab, or run live-page replication. The runner returns artifact paths
   and the component-map contract. Keep the screenshot bytes unchanged.
5. **Copy source components.** Inspect the saved screenshot. Use the URL path
   as a search hint in the local codebase, then locate the route and its
   components, styles, fonts, tokens and assets. Reuse those files in the naked
   workspace with realistic mock data; do not start the source app. Copy needed
   dependencies into the workspace so the published build stands alone. Preserve
   original assets, including every face pixel; do not redraw images. If essential
   assets are unavailable, report the blocker instead of opening the website.
   Implement the screenshot baseline before applying the brief's change. Write
   `<build>/components.json` as `{ "parts": [{ "marker": "header", "name":
   "Header", "role": "section", "sourceFiles": ["src/components/Header.tsx"], "rect":
   { "x": 0, "y": 0, "w": 1200, "h": 80 } }] }`. Use real source paths and
   screenshot pixel regions. Mark actual prototype elements with those stable
   data-proto-id values. These are agent-authored mappings, never a captured DOM.
6. **Check the copy.** Run
   `node tools/proto-build.mjs check-baseline <briefId> --codebase <id>`.
   The runner waits for rendering and compares the generated preview with the
   screenshot. A broken render returns diagnostics, never an acceptance gate.
   Fix visual differences and run the same command again. There are two agent
   repair rounds before remaining differences produce the existing acceptance
   question. Unchanged checks reuse their evidence. Present a required question
   in this conversation and record the actual answer with build-stream answered.
   Acceptance belongs to that baseline only. Free-text replies are instructions,
   not automatic permission to advance. A passed or accepted baseline starts its
   supervised preview automatically. Do not repeat serve steps manually.
   The capture remains one screenshot pixel per CSS pixel. If capture dimensions
   are needed, ask rather than claiming exact fidelity without evidence.
7. **Write the change.** Edit only the parts the brief is about, from the
   parts list and the copied files: use the saved screenshot and local source code; never open the reference URL. A part from the library is a
   library component copied into `src/parts/`; edit the copy. Send
   `build-stream.mjs focus <briefId> --codebase <id> <nodeId>` when you
   start on a part, so the site shows which one.
   - **Preview states**: every distinct mode a reviewer should reach
     (tabs and steps, empty/loading/error branches, overlays, toggles)
     is a state in `public/prototype.json` (id, title, one-line
     description, `parent` for branches) and a branch in the code via
     `usePreviewState` from `@proto-labs-inc/rig`; the ids in both must match.
     When the screenshot shows a dialog, represent it as a preview state. Use
     source code for its behavior; do not invent evidence for hidden states. The
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
   parallel, in the background, with the variant brief below; do not
   pass a model, and never a `name` (step 6 says why). Mobbin
   references are not gathered in a build: the baseline is the reference.
9. **Exercise interactions.** Test the behavior specific to the request,
   including meaningful keyboard, empty/error and data consistency cases. The
   runner's generic checks do not replace these assertions.
10. **Finish.** Run
    `node tools/proto-build.mjs finish <briefId> --codebase <id> --changed <marker,marker>`.
    It verifies types, markers, states and variants, generates previews, builds,
    verifies hosting, publishes and flushes required history before completion.
    Fix `needs-agent` diagnostics and rerun; delivery retries reuse verified
    output. Return only verified URLs. A blocked tunnel still permits static
    publication and retains the existing failed-live-view reporting policy.
    See `docs/create-runner.md` for checkpoints, timing and recovery.

## Blocked

A required decision is answered in the active coding-agent conversation.
Create or recover its saved question:

```
node tools/build-stream.mjs question <briefId> --codebase <id> --kind generic "<the question>" \
  --option <id>="<Label>" --option <id>="<Label>" [--recommended <id>] [--detail "<what you found>"]
node tools/build-stream.mjs await-answer <briefId> <questionId> --codebase <id>
```

Both return promptly with a stable question ID and structured `needs-input`
while unanswered. Present the returned question and options; wait for the
user's actual choice. A recommendation is not consent. Required choices have
no default countdown. Do not poll, start a listener, or create another question
to replace the same pending one.

Record exactly one option or free-text reply:

```
node tools/build-stream.mjs answered <briefId> <questionId> --codebase <id> --option <option-id>
node tools/build-stream.mjs answered <briefId> <questionId> --codebase <id> --text "<what the user said>"
```

Then resume the original command without `--again`. Questions, answers, and
copy-gate checkpoints are saved in the build directory. Repeated invocations
reuse the same state; repeated submitted answers do not apply twice. Follow
free text as the user's instruction within the original task's scope. The
website only receives progress saying input is needed in the coding agent.

A failure is `report_progress failed` with one plain sentence.

## The part brief

When delegating a screenshot copy correction, give the agent its marker,
workspace, source files, screenshot region and the latest check result. It owns
only that component's files, is not alone in the workspace, and must preserve
others' edits. It reads the saved screenshot and source components, changes code
and styles, then runs `check-part.mjs <briefId> --codebase <id> <marker>` and the
workspace typecheck. Never change screenshot pixels or visit the source URL.
Report what changed, pixel mismatch, and typecheck results. Missing assets or
unseen behavior require a question; a screenshot is not evidence of a DOM tree.

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
and `public/prototype.json`; a port free on this laptop that no other
prototype or library under `~/.proto` claims, in `vite.config.ts` and
`prototype.json` (they must agree), with the workspace's own token in
`public/__proto-workspace.json`, which every tool reads back from the
port before rendering in it; the page's tokens, fonts and body base in
`src/`; Tailwind when the source uses it; `pnpm install` from the
shared store. The rig is a dependency the template pins to one exact
version: `@proto-labs-inc/rig` (React) or `@proto-labs-inc/rig-vue`
(Vue), with `@proto-labs-inc/wire` for the manifest's types, all from
npm. Never vendor the rig or change its version by hand;
`modern-screenshot` stays a dependency of every workspace (the rig
lazy-imports it for comment capture).
`docs/build-read.md` describes the build folder.

## Rebuilding one section

For a screenshot-backed build (`reference.json` in its build folder), use the
saved image and `components.json` to locate the section. Edit its source-derived
component and check with `check-part.mjs`; never invoke `replicate.mjs` or fetch
the reference URL. Keep the other components intact, then run state checks and
publish. The live-read instructions below apply only to older builds.


A brief whose run is `rebuild-section` is a change asked from the
Frame's element picker: `get_brief` gives the prototype
(`prototype_slug`), the component (`section`, its `data-proto-id`) and
the change (`description`, the Frame's full edit prompt, scoped to that
component and its variant). Report `started` when work begins; only then may
the Frame mark the component as rebuilding. Then make the change in the prototype's workspace (the
running dev server shows it as you save), run `check-states.mjs` and,
for a variant, `previews.mjs`, then `report_progress done`. When the
prototype came from a streamed build (`parent_brief_id` is set), run
those two with `--brief <parent> --codebase <id>` so the build's stream
shows the change: the node is the one whose `marker` is the section.

### Copy retry scope

Retries keep the original screenshot and source mapping. Fix only the components
that still differ, then rerun the same command with `--check`. The tool renders
the whole local page and compares it with the same saved image. A pending gate
resumes its existing question and answer instead of asking again. The old
`--again`, `--page` and live recapture workflow are not used for creation.
