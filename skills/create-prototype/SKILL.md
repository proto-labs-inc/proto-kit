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
`docs/work-handoff.md` first. Fetch the brief with `get_brief`, use its persisted
`action` and target, and preserve its ID. A variations action belongs to
`add-variants`, not new-prototype creation. An old courier-delivery envelope
is not a current work request: ask the user for a current copied prompt.

For an explicit resume of this same brief, verify the codebase, creator,
prototype slug, and saved build checkpoint agree before reusing its workspace.
Then continue the same command without `--again`; do not re-create or overwrite
completed work. The unused-slug rule below applies to new creation, not a
verified same-brief resume. Missing or contradictory state requires input.

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
3. **Brief id.** For a website request, call
   `begin_prototype_build { codebase, slug, title, briefId }` with its existing
   ID, preserving the website card and action. Otherwise
   `begin_prototype_build { codebase, slug, title, description, useRealData }`
   returns a new/reused active ID; pass the brief's text you are building
   from (a setup document's brief, the user's request) as `description`
   and its `useRealData`, so the website shows what was asked. Report `report_progress { briefId, status: "started" }` when work actually
   begins, never merely because a prompt was copied.
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
   Pictures (logos, icons, illustrations, charts: `<img>`, inline
   `<svg>`, `<canvas>` and stylesheet images) are copied as the page's
   own files and set in as they are, never redrawn; nobody edits one to
   make a check pass.
   If the command returns `status: "needs-input"`, present its question in this
   conversation and stop at that checkpoint. Record the answer as described
   under Blocked, then rerun the same command. Do not advance to serving or
   composition while the choice is unanswered.
5. **Serve early.** The dev server the copy used has stopped; start the
   serve skill's steps 1 to 4 now (register, provision the tunnel, write
   the run spec, `supervise.mjs start`), in that order, and do not verify
   through the edge yet: the tunnel connects while you write the change.
   Registering and the heartbeat do not finish the build: its card stays
   up and every stage is still reported. `report_progress serving` comes
   later, at step 10, and `done` at the very end.
6. **The gate, then the parts left to fix.** The composed page is the
   copy's gate: the change is written on it when the page differs by at
   most `TAIL.PAGE_PROCEED_PCT` (0.5% of its pixels) and mounted.
   `proto-build.mjs` takes a copy over the gate through it itself: it
   copies once more after the page settles and, still over, returns a
   structured `needs-input` question. Present the options, recommendation,
   copy-quality details, and impact in this conversation. No choice is made
   by a timer. The checkpoint preserves completed capture and replication.
   After the recorded answer, its output's `gate` says what came of it:
   - `outcome: "proceed"`: the copy passed; `gate.line` says so in one
     line; relay it to the user as it stands.
   - `outcome: "build"`: the person said start on this
     copy; carry on.
   - `outcome: "reply"`: the person wrote what to do instead;
     `gate.instruction` is their words. Follow it as given, as the next
     thing you do (finish one part, skip one, use a placeholder image),
     then carry on.

   Every part in `toFix` is
   the long tail from here, each with its reason (`toFix[].reason`: a
   small share of the page, or simply not matched at the gate); you
   never fix a part yourself, not even a three-pixel one. For each,
   one `proto:part-fixer` subagent, all in parallel, in the background,
   with the part brief below. Do not pass a model, and never pass a
   `name`: a named agent becomes a teammate in its own session (under
   agent teams), which does not keep this session's permission mode,
   so every command of theirs asks the user; a plain subagent runs
   here with this session's mode. Carry on with step 7 while they run;
   when a fixer reports a part matched, say one short line ("The
   resizer now matches the page") and nothing more.
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
     `usePreviewState` from `@proto-labs-inc/rig`; the ids in both must match.
     When the read said a dialog covers the page (`tree.json` carries
     `overlay` with the backdrop's and the dialog's node ids, and the
     read printed one line about it), the dialog is a state of its
     own: the copy shows it as the page does, the page under it is
     the default state, and the dialog's own close control moves
     between them. The checks already compare parts under the
     backdrop with its shading accounted for. The
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
9. **Check, as tools.** When the variant units are back (the part
   fixers are the tail: `node tools/tail.mjs decide <codebase> --build
   <briefId>` prints where they stand, at once; relay its one line and
   never wait for them, they stop on their own budget):
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
    starts. When the edge check and the publish pass, report
    `report_progress { briefId, status: "done", prototypeSlug: <slug>,
    message: "Ready" }` (serve's step 7): that, and nothing earlier,
    finishes the build and closes its card. Tell the user once the
    prototype is reachable, not before. Never commit anything into
    the user's repos.

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

> Fix the part `<slug>` (`<name>`, node `<nodeId>`) of build `<briefId>`
> in codebase `<codebase>` so it matches the reference page. Its folder
> is `<workspace>/src/parts/<slug>/` (`<Name>.tsx`, `<Name>.module.css`,
> `component.json`); the build folder is
> `~/.proto/<codebase>/run/builds/<briefId>/`. What differs: `<the
> part's differs entry>`. Pass pictures are in `<build>/checks/<slug>/`
> (`<n>-live.png` the product, `<n>.png` ours, `<n>-diff.png` the
> difference). First run `node <kit>/tools/explain-diff.mjs <codebase>
> <slug> --build <briefId>`: it reads the page's element and our part
> at the differing spots and names each difference (a computed value,
> a box, a text, a reference that points at nothing, an image or a
> face that did not load, the colour behind the part). Apply the fix
> it names in the module or stylesheet, never in a picture file
> (`picture*`, `image*`, `background*`: the page's own, set in as it
> is; a difference inside one is its size or what is around it). Then
> run `node
> <kit>/tools/check-part.mjs <briefId> --codebase <codebase> <slug>`.
> Budget: three checks or two minutes from your start, whichever comes
> first; then stop and report. Done is `matched: true` from the check
> and no type error of yours in its `typecheck`; `stop: true` on a
> state that still differs or failed is not done, whatever the number.
> Never remove an element, a list item or a text the page has to quiet
> a diff: a difference is fixed by a value. A check that stops you
> without a match restores the part to how replicate wrote it (from
> the copy explain-diff kept); report `restored`. `<build>/read.json`
> holds the page's computed styles (`tree.json` names the element
> index) when you need a value explain-diff did not print. Never write a script against the
> Proto window or the headless Chrome (no attach.mjs, cdp.mjs, ws, port
> 9333 or 9444 from your own code). Write only in the part's folder.
> Report what explain-diff named, what you changed, and the last
> check's verdict and mismatch per state.

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

Copy-gate retries retain matched components whose captured inputs are unchanged
and whose generated files still exist. Only failing, changed, or missing
components are replicated again; the complete page is still composed and
checked. `proto-build.mjs` uses this behavior by default. Use
`--retry-mode full` for an explicit full retry, or `--again` to restart the
initial copy: it reads the page afresh, stops at the curation review again
(unless `--accept-curation`) and copies anew, for a read that was itself wrong
(the page mid-load, signed out, or showing a flash message). Run every later
step without `--again`. Missing or incompatible retry checkpoints fall back to
copying all components.
