---
name: prepare-screen
description: Prepare and verify one reusable, self-contained starter screen from an authorized setup inventory or custom URL. Shared by index-screens and create-prototype; not used to reconstruct an already verified starter.
---

# Prepare a screen once

Read and follow [background-browser.md](../../docs/background-browser.md) before browser work. Source captures run headlessly by default; foreground commands are blocked. Never override that guard during routine work. Visible sign-in requires explicit user authorization.


The caller supplies codebase, indexId, approved inventory version and entryId.
Setup keeps its member-confirmation boundary. A custom URL uses its claimed saved
brief to create a one-screen index before entering here. Call replication-check
before work, and resume that exact entry and workspace. Never apply requested
prototype feature changes to this baseline. Responsive fidelity and small
usability repairs are part of preparing the baseline, for both custom URLs and
every initial screen imported during setup.

Staff site preparation uses the rendered page and imported library only. Do not
request a customer repository or reference staff filesystem paths in a bundle.
Keep all components, fixtures and assets self-contained for later customer use.

## Inspect before copying

Use the run key `<indexId>-<version>-<entryId>` from the start, including inspection.
Run `node <kit>/tools/cdp/product-page.mjs '<exact-live-url>' --codebase <codebase>
--run <runKey>` and retain its `browserSession` path. Each entry gets its own source
window; never borrow a same-origin tab from another preparation or prototype.

All source evidence comes from one command. **Do not read kit tool source and do
not write capture, inspect, inventory, plan or local-check scripts**: every
script agents used to write (capture-refs, capture-containers, inspect1–9,
make-plan/build-plan, local-verify, check-controls) is a mode of this tool, and
its usage below is complete. If it fails, report the exact error; do not work
around it with your own CDP code.

```
node <kit>/tools/prepare-plan.mjs capture '<exact-live-url>' <plan-dir> \
  --browser-session <browserSession> [--states <plan-dir>/states.json] \
  [--breakpoints <js-breakpoints,comma>] [--height 900] [--capture '<profile-json>'] [--concurrency 3]
```

`<plan-dir>` is `<protoHome>/<codebase>/screens/plan/<runKey>`, outside the
source bundle. In one run (a few minutes) it reads the compiled responsive CSS
(again after opening each state), computes the required widths, captures every
reference PNG per state and width with the render profile below,
collects container observations for every state and width, inventories every
visible control (label, selector, enabled/disabled, widths where visible), and
writes `<plan-dir>/plan.json`: a schema-valid plan with every scenario the
verifier requires. State assertions (heading/text that identifies each state,
width-dependent visibility for responsive checks), disabled-control checks and
boundary checks are filled in from the source. It prints JSON: `widths`,
`controls`, `references`, `toFill` (everything left), `tagInCopy`,
`partialWidth`, `statesWithoutAutoAssertion`, `captureProblems`.

First run it with no `--states` file. Open and look at a phone, an intermediate
and a desktop reference in `<plan-dir>/references/` and every layout transition,
then write `states.json` for the dialogs, menus, validation and local
navigation states you see, and run capture again (it keeps everything already
filled in):

```json
{ "states": [
    { "id": "menu", "path": "/?state=menu",
      "steps": [{ "kind": "click", "selector": "button[aria-label='Open menu']" }] },
    { "id": "outside", "kind": "prototype-boundary", "path": "/?state=outside",
      "originatingControl": "link-settings", "destination": "/settings",
      "returnControl": "return-to-screen", "returnState": "default" } ],
  "controls": [ { "id": "return-to-screen", "selector": "[data-proto-id='return-to-screen']",
      "path": "/?state=outside", "expected": "Returns to the screen" } ],
  "containers": { "(width >= 40rem)": ".cards" } }
```

`steps` use the scenario actions in [verification.md](verification.md) and run
on the live source after a fresh load at each width; use only nonmutating
actions there. `path` is the copy's URL for that state (default
`/?state=<id>`). `controls` adds controls that exist only in the copy (such as a
boundary's return action). `containers` names a query container the tool could
not find. Pass JavaScript-driven layout transitions found in source with
`--breakpoints`.

Then fill only what the source cannot tell the tool, editing `plan.json`:
- each enabled control's `expected` and the `assertion` of its `pointer-<id>`
  and `keyboard-<id>` scenarios (every `"TODO: …"` string carries a hint);
- selectors listed in `tagInCopy`: add `data-proto-id="<id>"` to that control
  in the copy;
- controls in `partialWidth`: make the scenario reach the control at every
  width (for example its path opens the state that shows it);
- `responsiveCssReview` entries and container scenarios, when present.

`node <kit>/tools/prepare-plan.mjs lint <plan-dir>/plan.json` lists everything
verification would refuse; it must print `Plan is complete` before upload.
Interaction and keyboard scenarios without a real outcome assertion are refused.
Inspect every CSS warning and unresolved query in the browser before reviewing it.
Do not assume framework defaults. Container queries are not viewport
breakpoints; the tool observes them per state and width and only adds container
scenarios for rules it cannot prove unused.

### Width matrix and render profile

Verification runs a scoped matrix; `widths` in capture's output is the
layout-band set: 320 and 1440, both sides of each CSS boundary (floor and
ceiling of a fractional one; b-1, b and b+1 of an integer one), plus one
midpoint inside each band. Visual and responsive checks (and container
scenarios) run at every layout width. Interaction and keyboard checks run at
320 and 1440, plus the midpoint of each band listed in
`inventory.interactionBands` (a `[left, right]` pair of neighbouring band edges,
for a control that changes form there). State and isolation checks run once at
1440. Capture therefore takes reference PNGs only at the widths compared
screenshots need, and lint asks for exactly those.

References and the verifier draw alike (tools/cdp/render-profile.mjs): CSS
viewport at that width, 1x, sRGB, no scrollbars (custom `::-webkit-scrollbar`
ones included, and they take no layout width), focused, fonts and finite motion
settled, scrolled to the top; capture restores the source window afterwards.
Never compensate for rendering by hand: do not sample or fake scrollbars, add
scrollbar CSS, resize, pad or rescale reference PNGs, or change DPR. A
"Reference viewport dimensions do not match" failure means run capture again. To
replace one state's references without a full capture, use `node
<kit>/tools/cdp/reference.mjs <plan-dir>/references --widths <w1,w2,...> --height
<plan height> --name <state>- --browser-session <browserSession>` with that state
open in the source window, and put its printed map into the scenario's
`references`.

Open and visually inspect the reference screenshots before judging the layout.
Measurements, CSS extraction and clipping reports do not replace seeing the page.
Compare at least one phone, intermediate and desktop view selected from the
source-derived width matrix, plus each distinct layout transition. Record what
actually changes: headers, navigation, columns, order, wrapping and scrolling.
A control outside the initial viewport may be reachable by scrolling; test that
before calling it clipped. After recovery of the source window, run capture again.

A local overflow defect does not mean the whole source has no mobile layout.
Preserve the observed layouts and repair small usability defects in the copy:
wrap long labels with their actions, let flex/grid children shrink, size content
wrappers to their contents, and keep wide tables or chart cards in reachable
scroll regions. These repairs are included even when the brief says "without
additional changes". Do not ask the user to choose a desktop-only copy or another
reference solely because a source control clips at one width. Ask only when an
actual product/design decision remains after visual inspection and local repair;
keep genuinely unavailable source states explicit.

## Build the baseline

Read and name the live page with build-stream, using run key
`<indexId>-<version>-<entryId>` and `--no-send`. Scaffold with
`scaffold.mjs <entryId> --codebase <codebase> --brief <runKey> --screen-index <indexId> --inventory-version <version> --screen-entry <entryId>`.
Keep source under the resulting isolated screens/work directory. Reuse portable
product components, event handlers and their original responsive CSS. Inspect
source media/container queries, flex/grid constraints, min/max sizes, wrapping,
overflow and responsive visibility before writing the layout. When source is
unavailable, inspect those rules and layout changes in the signed-in browser at
every required width. Record which regions collapse, stack, scroll or disappear.
Capture mobile-only markup and assets at the width where they actually exist;
a desktop DOM capture can omit a mobile header or navigation rendered by JavaScript.
Implement those observed controls and states locally, including opening/closing
navigation and dismissing banners, rather than merely hiding desktop controls.
Do not infer mobile behavior from a desktop screenshot.

Do not use replicate.mjs's single-viewport fitting as the baseline layout: it
can pin captured widths and heights in pixels and does not recover breakpoint
rules. Build the screen from the responsive source rules and portable components.
Use fixed sizes only where the source intentionally fixes them. Preserve intrinsic
sizing and source min-width constraints; do not conceal failures with page-level
overflow:hidden, scale the desktop canvas, or invent breakpoint overrides.
Open and visually compare the copy and source at the same narrow, intermediate
and wide widths while building, before polishing any one width. Preserve the
desktop appearance while reproducing the observed narrower layouts and recording
any small source-defect repairs. Frozen HTML alone is never a finished screen.
Implement every recorded interaction against deterministic fixtures. Vendor the
library, dependencies, assets and lockfile; exclude credentials and sessions.
Keep all state URL-addressable through the rig. Omit fixed `viewport` metadata
from prototype.json so the Frame actually resizes the responsive screen. Preserve the source's disabled
controls. No live-product requests, navigation, authentication or writes.
For destinations not included in this screen, show a local state reading
"This screen isn’t included in this prototype" with a working return action.
Record it as a `prototype-boundary` verification state with its entry control,
destination, return control and source return state. Keep this fallback out of
`public/prototype.json`'s `states` array: that array populates the state map and
must contain only included product states. Keep the fallback URL-addressable
in the app and declared in the verification inventory. Test entry and return by
pointer and keyboard, direct URLs, reload and responsive layout. Return must work
without prior browser history. These states need local evidence, not live-source
screenshots. Copied product states remain `source` states with full visual checks.
Do not create a user's prototype or serve one for the baseline.

## Keep independent work moving

A failed verification preflight blocks final acceptance, not visual repairs,
interaction tests, keyboard tests or other screens. Record the exact failure and
continue all independent authorized work. Use `prepare-plan.mjs run` for
checks that can run while a plan or tool issue is being repaired. Preserve failures
and evidence; never lower a gate or mark ready to clear a blocker. Report progress
through screen_index and state which checks remain incomplete. Ask the user only
for a decision, access or permission that is actually missing, not to approve a
tool defect. Before stopping, review outstanding work and explain why each
remaining action depends on the blocker.

## Verify and save

Read [verification.md](verification.md) for the scenario format. While building,
loop on the local check, which builds the workspace and runs the plan with the
same runner as the final verification, in parallel, printing only failures:

```
node <kit>/tools/prepare-plan.mjs run <workspace> <plan-dir>/plan.json \
  [--only pointer-save,keyboard-save | --match '^(visual|responsive)-'] \
  [--widths 320,768,1440] [--bail] [--concurrency 6] [--no-build]
```

Each failure line names the screenshot to open; diff details are in
`<plan-dir>/local-check/results.json`. Start with `--widths` at a phone, an
intermediate and a desktop width and `--bail` (each scenario still runs only at
the widths its category needs); finish with a full run (no
filters) before uploading. Inspect the actual output images at matching widths.
A passing build or geometry report alone is not visual verification.
After a layout fix, rerun the affected widths and interaction/state checks.
`verify` saves each passed check under the screen cache; running it again for the
same build and plan reruns only failed or changed checks.
Report progress through screen_index. Upload with
`screen-index.mjs upload <codebase> <indexId> <version> <entryId> <workspace>`.
This archives source and compiles that exact archive once. Then run
`screen-index.mjs verify <codebase> <screenId> <plan-dir>/plan.json`.
The tool tests the archived compiled build, uploads private evidence and calls
finish only after all required checks pass. Do not submit handwritten success
booleans or fabricate reports. Inspect failures and screenshots, repair source,
then upload and verify again. Uploading changed source invalidates its old build.
A ready revision is immutable; changes require a new inventory revision.

The cloud validates report coverage and artifact binding, not browser execution.
Return the verified screenId. Setup continues its inventory; custom creation
clones this starter before applying the user's changes. Do not clone until ready.

## Existing starters

Use `screen-index.mjs reverify <codebase> <screenId> <plan.json>` to test existing
immutable artifacts using a freshly inspected reference inventory. If a compiled
build is missing, prepare it once with `screen-index.mjs prepare` first. A failed
old screen remains unavailable; repair it through a new approved revision.
Never rebuild a starter during selection. Cloning checks current eligibility and
performs a load/asset/initial-state/rig smoke check. Continue the serve skill's
publish before reporting the prototype available.

After upload and verification succeed, release this preparation's source window
with `node <kit>/tools/cdp/product-page.mjs release --codebase <codebase> --run <runKey>`.
Explicit cancellation also releases it. Failure or interruption retains it for
resume. Release only after all workers using its source have finished.
