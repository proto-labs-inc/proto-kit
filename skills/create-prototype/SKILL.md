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
`action` and target, and preserve its ID. Read request content exclusively from
`brief.inputs` using `tools/brief-inputs.mjs`; identity, action and target stay
top-level. A variations action belongs to
`add-variants`, not new-prototype creation. An old courier-delivery envelope
is not a current work request: ask the user for a current copied prompt.

For an explicit resume of this same brief, verify the codebase, creator,
prototype slug, and saved build checkpoint agree before reusing its workspace.
Then continue the same command without `--again`; do not re-create or overwrite
completed work. The unused-slug rule below applies to new creation, not a
verified same-brief resume. Missing or contradictory state requires input.

## Progress reporting

Follow `docs/build-progress.md` as soon as a saved request arrives. Report Connect
as active on that exact briefId when connection verification starts, before
`whoami` and `get_brief` finish. Complete that activity only after verification,
then report Review before accessing external context. If authentication prevents
the initial report, reconnect and deliver it as soon as possible. Do not wait for
a title, slug, or workspace. Preserve completed requests and verified resume
checkpoints.

## A tool for each goal

Every way of seeing or checking the prototype is a kit tool that knows
the right browser, display and paths. Use these and nothing else: no
browser, screenshot, `headlessPage` script or `headless.mjs` call of your
own (Chrome's `--screenshot` mode never exits, and hand-made renders
used the wrong display and disturbed the checks running beside them).

| To… | Run |
|---|---|
| see a state, a variant, a part or the whole page | `node tools/look.mjs <workspace> [--state <id>] [--variant <set>=<id>] [--part <marker> \| --page]`, then read the picture it prints |
| see one variant in every state (a variant builder, checking its own work) | `node tools/previews.mjs <workspace> --only <set>=<id>` |
| know what is broken (blank views, errors, parts out of place) | `node tools/check-states.mjs <workspace> --brief <briefId> --codebase <id>` |
| make the variant previews the site shows | `node tools/previews.mjs <workspace> --brief <briefId> --codebase <id>` |
| pick a free slug | `list_prototypes { codebase }` |

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
   `~/.proto/<codebase>/prototypes/<slug>/` and in the codebase's gallery.
   One call answers the gallery: `list_prototypes { codebase }` returns
   `taken`, every slug the gallery or a build already holds. Either match
   is a collision; keep the title and take the first of `<slug>-2`,
   `<slug>-3`, … that is in neither, without asking. Only when
   `list_prototypes` itself fails, stop with `needs-input` rather than
   risk an upsert. Never update, reuse, replace, re-register, restart, republish, or
   otherwise mutate an existing prototype during creation.
3. **Brief id.** For a website request, call
   `begin_prototype_build { codebase, slug, title, briefId }` with its existing
   ID, preserving the website card and action. Otherwise
   `begin_prototype_build { codebase, slug, title, description, useRealData }`
   returns a new/reused active ID; pass the brief's text you are building
   from (a setup document's brief, the user's request) as `description`
   and its `useRealData`, so the website shows what was asked. Early reports
   already mark a saved request started; do not reset its status.
   Copying a prompt never starts work.
4. **Copy the page**, one command. This is the Copy workflow step, separate
   from Build. Capture, curation, replication, and the copy-quality gate all
   report `copy`; report `build` only after the gate allows the requested
   change. The live URL is the visual source of truth.
   Before opening a browser or tab, inspect readable existing tabs in the
   in-app browser, the user's Chrome, and Proto Chrome on port 9333. Prefer an
   exact `referenceUrl` match, then the same path, then the same origin, and
   reuse a signed-in tab that provides the DOM and capture access needed. Only
   start Proto Chrome or open a duplicate after those checks; ask the user to
   sign in only when no readable context has a usable session. If the URL still
   cannot be read, stop rather than inventing the page from source or memory.
   `node tools/proto-build.mjs <briefId> --codebase <id> --page
   <referenceUrl substring> --slug <slug> --title "<title>"`.
   It **freezes** the page (the default, `--copy freeze`): it reads the
   page, names its boxes from the read without stopping, scaffolds the
   workspace, and lifts the rendered page into it as it is: the DOM after
   the page's scripts ran (scripts removed), the page's own stylesheets
   as written, and every font and image it loaded, saved locally. Nothing
   is rebuilt, so there is no part to fix and no copy gate; it takes
   seconds. It then renders the workspace and checks every named box's
   position against the read. It prints the parts list (also at
   `<build>/parts.json`): each named box's node id, name, marker
   (`data-proto-id` in the frozen markup), rect, and `status` (`matched`,
   or `moved`/`missing` with `delta` px), the sections, `off` (any box not
   in place) and the frozen files:
   - `src/frozen/page.html`: the body's markup. Every element carries
     `data-pf` (its number in the read); named boxes carry their marker.
   - `public/frozen/styles/`, `public/frozen/assets/`: the page's CSS and
     files. Never edit these; they are the page.
   - `src/frozen/Frozen.tsx`: mounts the page into `<body>` and swaps
     marked elements for React components (`replace`).
   - `src/App.tsx`: `<Frozen />`, where the change goes (step 7).
   Every event the site needs for copying is sent by the tools. Report
   agent-authored changes and context through docs/build-progress.md.
   `--copy rebuild` is the older copy that rebuilds every part as a
   component and checks it against the page (curation review stop,
   replicate, gate, part-fixers); use it only when asked.
   Pictures (logos, icons, illustrations, charts: `<img>`, inline
   `<svg>`, `<canvas>` and stylesheet images) are copied as the page's
   own files and set in as they are, never redrawn; nobody edits one to
   make a check pass.
   If the command returns `status: "needs-input"`, present its question in this
   conversation and stop at that checkpoint. Record the answer as described
   under Blocked, then rerun the same command. Do not advance to serving or
   composition while the choice is unanswered.
   **Variants start here, before anything else.** When the brief asks
   for variants and the copy is frozen, the next thing you do once the
   copy returns is step 8's start: pick the decision, find the element
   in `src/frozen/page.html` by its marker (or by text and `data-pf`,
   adding a `data-proto-id` if it has none), run `variant-set.mjs`,
   wire the switch into `App.tsx` and dispatch the builders. Do not
   start the server, read the codebase's source, write shared data or
   add preview states first: the builders need only the frozen markup
   and the brief, and every minute before they start is a minute added
   to the build. Serving (step 5) and the rest of the change (step 7)
   happen while they work.
5. **Serve early.** The dev server the copy used has stopped; start the
   serve skill's steps 1 to 4 now (register, provision the tunnel, write
   the run spec, `supervise.mjs start`), in that order, and do not verify
   through the edge yet: the tunnel connects while you write the change.
   Registering and the heartbeat do not finish the build: its card stays
   up and every stage is still reported. `report_progress serving` comes
   later, at step 10, and `done` at the very end.
6. **The gate, then the parts left to fix.** A frozen copy has neither:
   `gate.outcome` is `proceed` and `toFix` is empty. If `off` names a box,
   say so in one line ("The logo link sits 9 px off in the copy") and carry
   on; never patch the frozen markup or styles to move it. The rest of
   this step is the rebuild copy's (`--copy rebuild`). The composed page is the
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
7. **Write the change.** The variant builders are already running
   (the end of step 4); write the rest of the change (shared data,
   preview states, wiring) while they work. A builder owns its variant:
   when it reports back with its pictures checked, keep its files as
   they are. Change a variant only for a fault check-states or the
   previews name (step 9), and then only that fault; never rewrite
   one to your own taste.
   On a frozen copy, find the elements the brief is
   about in `src/frozen/page.html` (by marker, or by text and `data-pf`;
   the parts list's rects say where each sits) and change only those:
   - A redesigned region: write it as a React component under
     `src/change/`, styled to match the page. Reuse the page's own class
     names from the frozen markup (they carry the page's exact styles from
     `public/frozen/styles`), and the codebase's source for structure and
     wording when it helps. Put it in place of the marked element:
     `<Frozen replace={{ "<marker>": <PausedNotice /> }} />`. Its root keeps
     the marker (`data-proto-id`). A region with no marker gets one: add
     `data-proto-id="<kebab-name>"` to that element in `page.html`.
   - Small edits (a word, an attribute, removing an element): edit
     `page.html` directly.
   - Interaction: the frozen page has no scripts. Hover, focus and
     transitions still work (they are CSS). Anything that must happen on
     click, inside the change, is React state in your component (and a
     preview state when a reviewer should reach it).
   - The frozen page is in the theme it was captured in (`frozen.json`
     `htmlAttrs`); keep the change in that theme.
   - Styling the change: the same rules as the frozen variant brief
     below. Use the page's own class names from the frozen markup, and
     custom properties exactly as `public/frozen/styles` writes them.
   On the rebuild copy, edit only the parts the brief is about, from the
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
   On a frozen copy the baseline is the frozen element itself:
   `<Frozen replace={{ "<marker>": <XVariants baseline={<FrozenHtml marker="<marker>" />} /> }} />`
   (`FrozenHtml` from `src/frozen/Frozen`). Variant builders write their
   variant against the frozen markup and the page's class names, not a
   copied part file.
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
     set's `status` cleared. It also pictures every variant in every
     other preview state, into the build folder (its `states` list gives
     each picture's path; they are never published). Look at the change
     through these pictures and `look.mjs` (the table above), never
     through screenshots of your own.
   - On a frozen copy the untouched page is the page itself: check-states'
     pixel clusters outside the change are the headless Chrome's colours
     against the Proto window's (about 0.4%), not a copy problem. Act on a
     moved or missing marker; leave pixel-only differences alone.
10. **Serve.** Continue in the serve skill at step 5 (verify through the
    edge, publish, report). Publishing reports its actual upload and availability
    checks, a clean screenshot of the built files, and completion. Registration
    and heartbeats do not complete the brief. Tell the user it is reachable only
    after verification. Never commit anything into the user's repos.

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
> workspace, then look at your variant as it renders:
> `node <kit>/tools/previews.mjs <workspace> --only <marker>=<id>` pictures
> it in every preview state in about a second; read each picture it
> lists and fix what looks broken. Check each picture for: the variant
> wider or taller than the card it replaces; points, dots or markers not
> sitting on their line; a label the direction names that is missing
> (such as "Today"); an element missing or shown twice; text clipped or
> overlapping; rows out of line; a control in the wrong place; wording
> that does not fit the state (a resuming view that still says
> "paused"); colours the page does not use. Its `unstyled` lists class
> names on your variant that no stylesheet defines: they do nothing, so
> fix every one (copy the class the page uses, or move the style into
> your module CSS). Two rounds at most. Report the files written, the
> last typecheck's result and what the pictures showed.

On a frozen copy, the brief names the frozen element instead of a part
file, and adds how to style (`<repo>` is the product's repo, the
directory you run in):

> The part it varies is the frozen element marked `<marker>` in
> `src/frozen/page.html` (and the change's component, if one is written).
> Style with the page's own class names, copied from that markup: they
> carry the page's exact colours, type and spacing from
> `public/frozen/styles`, and the module CSS only lays them out. Where a
> custom property is needed, use it exactly as the page's CSS does: find
> it first (`grep -o "var(--<name>)[^;]*" public/frozen/styles/*.css`)
> and copy the expression. Never wrap a property in a colour function of
> your own (`hsl(var(--x))` when the page writes `var(--x)` breaks the
> colour) and never invent a value the page does not use. The workspace
> compiles no Tailwind: a utility class exists only if the page's CSS
> already has it, so copy class names from the markup exactly as
> written (`px-(--card-padding-x)`, not `px-[var(--card-padding-x)]`)
> and write anything new in the module CSS. The product's codebase is
> at `<repo>`. Anything the variant shows that the page does not (a
> badge, a spinner, an alert, a button's loading state, a list row, an
> icon) comes from there: find the component that renders it (its
> shared UI package first, then the app's own components), copy its
> markup and class names, and never draw or style your own. The page's
> CSS is the whole app's build, so the codebase's classes are almost
> always in it; the class check below names any that are not. An icon
> the page does not show is the codebase's own icon library's: read its
> shape from the installed package (in a monorepo it sits in the app's
> or UI package's `node_modules`: `find <repo> -path
> "*node_modules/lucide-react/dist/esm/icons/<name>.js"`) and write the
> SVG with the attributes the page's icons carry. Never emoji.

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
