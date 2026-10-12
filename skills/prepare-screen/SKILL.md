---
name: prepare-screen
description: Prepare and verify one reusable, self-contained starter screen from an authorized setup inventory or custom URL. Shared by index-screens and create-prototype; not used to reconstruct an already verified starter.
---

# Prepare a screen once

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

Use the signed-in live page and source to record every visible control, its
expected local outcome, enabled/disabled state, meaningful URL states and CSS
breakpoints. Exercise only nonmutating actions on the live product; determine
mutating outcomes from source and test them only against local fixtures.
Save the reference inventory and executable scenarios outside the source bundle.
Run `node <kit>/tools/responsive-css.mjs <exact-live-url> <responsive-css.json>
[cdp-port]` against the existing signed-in source tab. It reads the compiled
styles through Chrome, including Tailwind utilities, nested media rules and
cross-origin stylesheets. Copy its `breakpoints` into the reference inventory;
keep its JSON as the plan's `responsiveCss`. Do not assume framework defaults.
Run again after opening states that load additional styles and merge the findings.
Inspect every warning and unresolved query using the source/browser before
proceeding. Width queries with fractional boundaries remain fractional.

Use the returned `widths`: narrow/wide endpoints, each CSS boundary and adjacent
integer widths, plus one sample inside each interval for fluid wrapping. Add any
JavaScript-driven transitions discovered in source to inventory.breakpoints and
recompute widths with screen-verification.mjs's widthsFor. Capture reference PNGs
at those widths using the same DPR and color profile as the headless renderer.
Container queries are listed separately with their names, conditions and selectors.
They are not viewport breakpoints: inspect the actual query container at each
layout, vary its available space to cross each threshold, and record the resulting
viewport widths in inventory.breakpoints as additional probes. For em/rem or
container-relative units use that container's actual font/size context. If its size
cannot be driven by viewport changes, add explicit container-size scenarios and
reference captures in the plan; do not claim that a viewport sweep covers it.
Include dialogs, menus, validation and local navigation states.
Use the existing CDP capture tools.
Open and visually inspect the reference screenshots before judging the layout.
Measurements, CSS extraction and clipping reports do not replace seeing the page.
Compare at least one phone, intermediate and desktop view selected from the
source-derived width matrix, plus each distinct layout transition. Record what
actually changes: headers, navigation, columns, order, wrapping and scrolling.
Scroll the page and inspect its intentional horizontal scroll regions. A control
outside the initial viewport may be reachable by scrolling; test that before
calling it clipped. Restore the source browser's viewport after inspection.

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
Do not create a user's prototype or register a serving tunnel for the baseline.

## Verify and save

Read [verification.md](verification.md) for the executable scenario format.
Inspect the actual output images at matching widths and exercise the responsive
controls. A passing build or geometry report alone is not visual verification.
After a layout fix, rerun the affected widths and interaction/state checks.
Report progress through screen_index. Upload with
`screen-index.mjs upload <codebase> <indexId> <version> <entryId> <workspace>`.
This archives source and compiles that exact archive once. Then run
`screen-index.mjs verify <codebase> <screenId> <plan.json>`.
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
actual Frame check before reporting the prototype available.
