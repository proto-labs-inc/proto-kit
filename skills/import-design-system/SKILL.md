---
name: import-design-system
description: Import your product's design system into Proto. Reads a live page of your product in your own browser, and fills the library with its light and dark colours, type styles and components, each written from the product's own rendering and checked against it pixel for pixel, so prototypes are built from the real thing. Use when setting up a codebase's library, when the user asks to import or sync their design system, or when the library page shows nothing imported.
---

# Import a design system

Work is requested in this conversation. Imports do not start a listener or
wait for website commands. Keep finite checks of the library's local component
request queue during this active import, then finish.

You are turning a real product into its design system: its colours,
its type styles and its components, each a React component with typed
props whose looks and states are prop sets, identical to the product
in every state the page shows. The output is the **library contract**
(`docs/library-contract.md`) inside the library app at
`~/.proto/<codebase>/library/`. The user watches that app fill in as
you work, and prototypes import these components later.

**The page already knows every value.** The kit's tools read it: one
call surveys the page, one call writes a component from the live
element and one call checks it against the product. Your job is the
judgment the tools cannot make: which components the product has,
what the product calls them, and which of their looks and states
matter. Everything else is a tool call. A small import finishes in a
couple of minutes; if you find yourself writing CSS by hand, reading
computed styles one at a time, or composing a script, stop: the tool
exists.

## Report every stop before completion

Before stopping for any reason before the completion gate below passes,
call `report_setup_action { codebase, action: { message } }`.
The website derives the current step from setup progress and places the
blocker there automatically. Report only the message; never send a step.
This includes questions, sign-in, missing access or files, approvals, tool or
service failures, exhausted recovery attempts, and user-requested pauses.
Explain the blocker and the concrete next step in `message`; when user input
is needed, tell them to reply in this conversation. A chat message alone does
not show **Action needed** on the site. Routine tool execution and bounded
retries while actively working are not stops.

If the tool is not available, run
`node <kit>/tools/setup-action.mjs <codebase> '<message>'`.
Retry a transient reporting failure once; if reporting still fails, tell the
user the site could not be updated. Do not claim success without confirmation.
If no codebase id exists yet, preserve progress and explain the blocker in
chat; report it once the id exists if still unresolved. Never invent an id.

Verify the blocker is resolved, then call
`report_setup_action { codebase, action: null }` (or
`node <kit>/tools/setup-action.mjs <codebase> clear`) before resuming.
Repeat for every later stop. A reply, heartbeat, or partial publication does
not by itself resolve the blocker or satisfy the completion gate.

## The one rule

Never invent a value. Every colour, size, gap, weight and wrap comes
from the live page, and the tools take it from there: computed styles
for the look, the product's own declared rules for sizes, margins and
grid tracks, its own @font-face files, its own images. A component
that does not match the product is fixed by reading what differs,
never by nudging numbers until the diff goes quiet.

**Pictures are taken, never redrawn.** A logo, an icon, an
illustration, a chart: whatever the product draws as an `<img>` or
`<picture>`, an inline `<svg>`, a `<canvas>` or a background image is
copied from the page as its own file and set into the component as it
is (`snapshot.mjs` does it). It matches on the first check. Never edit,
redraw or restyle a picture file to chase a difference: that is a
long tail with no end. A difference inside a picture is its size or
what is around it; if the file itself is wrong, the state read the
wrong element: correct the plan and run `snapshot.mjs` again.

## Tools

All paths from the kit root (the installed plugin root the host
exposes: `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `CURSOR_PLUGIN_ROOT`;
otherwise the root above this skill's `skills/` directory). Do not
read their source to learn them; the signatures here are complete.

```
node tools/host-library.mjs <codebase>             serve the library (idempotent); prints local:, tunnel:
node tools/library.mjs init <codebase> <codebase> <source> --page-url <url> --page-title "<title>" --favicon <file>
node tools/publish-library.mjs <codebase> [--wait] publish; returns at once when one is running (it carries yours)
node tools/survey.mjs <codebase> --theme <light|dark>  the visible theme in one read (≈1 s); writes palette.json
node tools/plan.mjs <codebase> '<edits>'            the draft plus your edits → run/plan.json
node tools/import.mjs <codebase> --stage foundations  import colours, type and inventory only
node tools/import.mjs <codebase> --stage <core|extended> --theme light  build only this stage
node tools/library.mjs stage <codebase> <foundations|core|extended> complete  verify and finish one stage
node tools/import.mjs <codebase> --stage <core|extended> --check-theme <light|dark>   check only this stage in the visible theme
node tools/snapshot.mjs <codebase> <json | @file> --theme <light|dark>  write one component from its live instances
node tools/check.mjs <codebase> <slug> --theme <light|dark> [--state <name>] [--activity "<line>"]   check it; each pass lands
node tools/explain-diff.mjs <codebase> <slug> --theme <light|dark> [--state <name>]   why a state differs: the product's value and ours, named
node tools/tail.mjs decide <codebase>                 the tail's numbers now, at once: one line to relay when a unit reports; it never waits
node tools/library.mjs component <codebase> <slug> status done
node tools/library.mjs component <codebase> <slug> status skipped --kind <kind> --reason "<sentence>" --screenshot <png>
node tools/library.mjs event <codebase> [slug] "<activity>"
node tools/library.mjs take-queued <codebase>
node tools/finish-import.mjs <codebase>
```

The headless Chrome that draws every copy is launched with the Proto
window's own display (its real device scale factor and colour
profile), so a component written from the page matches it to the
pixel. Capture and check tools read the current Proto page. Before
capturing it, the agent explores the signed-in product through its page
controls over the debug port. Open existing projects, views, menus and
settings to discover representative components without asking the user
to navigate. Do not create, edit or delete product data for the import.
Once checks or repair agents start, keep their reference page stable.
The Proto window is started in sRGB
(`tools/cdp/chrome.mjs`): one started without it draws through its
screen's colour profile, and every component then differs by one
uniform colour shift (explain-diff says so); quit it and start it
again when no import is running. When this workflow needs a theme change,
discover the product's theme control in its account or appearance menus
and switch it yourself. Ask only after exploration finds no usable control
or a real access blocker. Holding a hover or focus
look on an element (`"force"`) is done with the DevTools pseudo-class
and let go straight after.

## Preparation

The import has exactly three sequential stages: **Foundations**, **Core
components**, and **Extended library**. Finish each stage completely before
starting the next. Every component must reach a terminal outcome: verified or explicitly
skipped (including failed attempts with their reasons). Failed and skipped
components do not block stage completion and stay visible as gaps. Repairs may run in parallel within the active stage, but none may
continue into a later stage. Do not launch prototype work until the import
requested here is finished.

The following discovery and planning prepare those stages; they do not build
components. The library shows the three steps and their verified counts.

## Order of operations

1. **Host and open the run**, in one shell line: `host-library.mjs`
   (setup usually started it; it returns at once), then `survey.mjs
   <codebase> --theme light`
   for the page's title and favicon, then `init` (fetch the favicon to
   a file first; leave `--favicon` out when there is none), then
   `publish-library.mjs` in the background. Run the light survey again after
   `init` so its capture belongs to the current import; the first survey only
   supplied the page title and favicon. `init` appends "Reading
   the source": the user sees the import is alive in seconds. On
   `tunnel: blocked` the import runs exactly the same (checks use the
   local address, publishing goes over 443); say the serve skill's
   sentence once and carry on. On `tunnel: none` (the site could not be
   reached) the same: the library is up on its local port, every check
   uses it, and `host-library.mjs` shares it when run again later.


2. **Discover a representative page and light theme.** Verify sign-in;
   ask the user to authenticate only when it is actually needed. Once
   signed in, handle discovery yourself. From a welcome screen or empty
   list, open the product's navigation and inspect existing projects,
   dashboards and work items until a representative view is visible.
   Explore relevant menus and tabs to identify component states. Do not
   ask the user to click around or confirm routine navigation. If no
   usable existing content is available, explain what you checked and
   ask for the missing content or access; do not create sample records.
   Discover and use the theme control to select light mode, then return
   to the chosen view, save its actual URL with
   `setup-codebase.mjs --codebase <codebase> --live-url <actual-url>`,
   and survey again. Finish navigation before capturing states and keep
   the reference view stable while checks or repair agents run.

3. **Plan: edit the survey's draft, briefly.** The survey prints the
   draft one component a line: its slug, its looks with their text, and
   its picture (open a few pictures if a name is unclear). The draft
   takes every candidate as a component with placeholder names. Say
   only what you change, in one call to `tools/plan.mjs`; it writes
   `~/.proto/<codebase>/run/plan.json`:
   ```
   node tools/plan.mjs <codebase> '{
     "keep":  ["button-connect-github", "checkbox", "form-field-organization", …],
     "merge": { "button-connect-github": { "button-feedback": "Text" } },
     "name":  { "button-connect-github": "Button", "form-field-organization": "FormItemLayout|form-item-layout" },
     "looks": { "checkbox": { "Default": "Checked", "Look 2": "Unchecked" } },
     "stage": { "button-connect-github": "core", "form-field-organization": "core", "navigation": "extended" }
   }'
   ```
   This is the one step that is yours; the rest is tools, and the
   summary holds what you need, so do not read the live page yourself:
   - **Keep every kind of component the product has**: primitives,
     fields, composites (header, panel, table, navigation). Leave out
     the page's decoration (a promo banner and its buttons) and
     anything that is not the product's component.
   - **One component per kind**: groups that are one component in two
     looks merge (`merge`: the other's look joins, its hover and focus
     with it).
   - **The product's names** for components and looks (`name`, `looks`).
     Slugs follow the name, or come after a `|`.
   - **Anything missing** goes in `"add"` as `{ "slug", "name", "states":
     [{ "name", "selector", "force"?, "of"? }] }`.

4. **Stage 1 — Foundations.** Run
   `node tools/import.mjs <codebase> --stage foundations`.
   This writes colours, type styles and the full inventory, without building
   any component. The plan assigns each component to `core` or `extended`.
   Common controls default to core; composites default to extended. Review
   those assignments and use the plan's `stage` edits for product-specific
   names. Core includes buttons, fields, selects, checkboxes, radios, switches,
   tabs, badges, menus, dialogs and tooltips. Extended includes tables,
   navigation, panels and specialized widgets.

   Survey and apply **both** themes now. Use the product's theme control,
   survey dark, and apply its palette with
   `node tools/library.mjs tokens <codebase> dark @<dark-palette.json>`.
   Apply the current light survey's palette too if needed. Both surveys must
   belong to this import and use the same token names; never use a copied
   light palette as evidence of a dark survey. Then run
   `node tools/library.mjs stage <codebase> foundations complete`.
   Only a successful command marks Foundations done. Publish this milestone
   and say "Foundations are done; starting core components."

5. **Stage 2 — Core components.** Switch back to light on the same reference
   view. Run `node tools/import.mjs <codebase> --stage core --theme light`.
   Only core components build, up to twelve at a time. Switch to dark and run
   `node tools/import.mjs <codebase> --stage core --check-theme dark`.
   Do not resurvey or rewrite palettes unless they changed: that invalidates
   earlier checks. Keep the reference page stable while checks or repairs run.

   The runner records failed builds and theme checks as skipped with a reason,
   including when no screenshot could be captured. These are terminal gaps:
   keep them visible and continue. Do not require repairs before advancing.
   Pending, queued or actively importing components must finish their attempt
   first. If repairs are undertaken in this stage, finish or explicitly skip
   them before advancing; recheck changed built components in both themes.

   Run `node tools/library.mjs stage <codebase> core complete`.
   It requires every core component either to pass every declared state in
   both themes or to have an explicit skip reason and kind.
   Publish this milestone and report the verified count and any gaps before
   starting the extended library. No extended component starts before this succeeds.

6. **Stage 3 — Extended library.** Repeat the same light build, dark check,
   repairs and both-theme verification with `--stage extended`. Finish with
   `node tools/library.mjs stage <codebase> extended complete`.
   Even an empty stage gets its explicit checkpoint. Then run the Finish
   checklist: only `finish-import.mjs` reporting `outcome: "published"` means
   the full import is finished. There is no background repair tail after
   completion in the sequential workflow.

If anything interrupts you (a question, a crash, a resumed session):
do that, then come back here. `init` resumes an open run without
touching what is there; `manifest.json` says what is done; run
`import.mjs --stage <active-stage>` with a plan listing only components
that need rebuilding. Keep the full inventory and stage assignments intact;
stage checks always validate the complete recorded inventory. Use scoped
`--check-theme` for missing checks instead of rebuilding matching components.

## Verdicts

`check.mjs` says, per state, and lands each as a pass whose line says
the same in the product's words. These count as matching:
- `match`: identical to the product.
- `shifted`: identical once moved one device pixel; a placement.
- `context`: every difference lies in a photo (each browser scales
  photos with its own rasteriser) or under something the page lays
  over the component (a floating card and its shadow).
- `faint`: a few stray edge pixels, under 0.3% of the component: the
  antialiasing of the page's own layers (an icon inside a scrolling
  header), not a look the component gets wrong.
- `offscreen`: identical where the product shows it; the viewport cuts
  the rest off.

`differs` is the one to fix: `clusters` say where (CSS px inside the
component), the pass pictures show what, and `explain-diff.mjs` says
which value: it reads the product's element and ours at the differing
spots and names each difference (a computed value, a box, a text, a
reference to an id that no longer exists, an image or a face that did
not load, the colour behind the component). When nearly every pixel
differs because the whole box is another colour, it says that first,
from the two pictures, and names the colour property behind it: the
product's value to write, or, when both sides compute the same colour,
that the difference is not the component's (an opacity or filter on
the page, an animation, or the Proto window's colour profile; `blame`
is then `outside` and the unit stops with that reason). When every
value reads the same it says what that leaves (a held state, a
transition, an effect around the element, a visited link). Never spend a unit on a
verdict that counts as matching. `context` also covers what the page
lays over a component without the pointer reaching it (a placeholder
painted over a field) and what shows through outside its rounded
corners (an icon under a badge): those pixels are the page's.

A resting state is compared with one frame of the resting page, taken
when the run starts; a state held with a pseudo-class is captured live,
one at a time. If the run says the pointer is over the product page,
ask the user to move it off the Proto window: what it rests on shows
its hover look.

## The unit brief

> Fix `<Name>` (`<slug>`) so it matches the product in every state.
> Its folder is `~/.proto/<codebase>/library/src/components/<slug>/`
> (`<Slug>.tsx`, `<Slug>.module.css`, `component.json`, `notes.md`),
> written from the live page by `tools/snapshot.mjs`; `component.json`
> names each state's live element. What differs: `<the toFix entry>`.
> Kit root `<kit>`; do not read the tools' source.
> First run `node <kit>/tools/explain-diff.mjs <codebase> <slug>
> --theme <theme>`: it reads the product's element and our copy at the
> differing spots and names each difference (a computed value, a box,
> a text, a reference that points at nothing, an image or a face that
> did not load, the colour behind the component); its plain lines come
> first, its JSON last. Apply the fix it names in the module or its
> stylesheet: the value to write is the product's, never a number
> between the two, and never in a picture file (`picture*`, `image*`,
> `background*`: the product's own, set in as it is; a difference
> inside one is its size or what is around it). Then run `node <kit>/tools/check.mjs <codebase> <slug>
> --theme <theme> --activity "<what you changed, in the product's
> words>"`. Budget: three checks or two minutes from your start,
> whichever comes first; then stop and report. Done is `matched: true`
> from the check and no type error of yours in its `typecheck`; `stop:
> true` on a state that still differs is not done, whatever the
> number. Never remove an element, a text or a list item the product
> has to quiet a diff: a difference is fixed by a value. A check that
> stops you without a match restores the folder to how the import
> wrote it (from the copy explain-diff kept); report `restored`. If a
> state's live element is the wrong one, correct the plan entry and
> run `node <kit>/tools/snapshot.mjs <codebase> <spec> --theme
> <theme>` again instead (that counts as a check). Never write a script against the
> Proto window or the headless Chrome (no attach.mjs, cdp.mjs, ws,
> port 9333 or 9444 from your own code): explain-diff is your one read
> of the page. Never reload or navigate the product tab. If
> explain-diff's `blame` is `outside`, stop and report its reason: no
> value in the folder fixes it. Write only in the component's folder; never touch
> `public/` or run `library.mjs`. Report as data: done or skipped, each
> state's last verdict, what explain-diff named and what you changed,
> and for a skip (which allows this stage to finish) the kind (`did-not-match` or `could-not-isolate`),
> one sentence of at most 140 characters in the product's terms, and
> the survey picture's path.

## Components, as the tools write them

`snapshot.mjs` writes a clean, typed component, not a markup dump:
- `<Slug>.tsx`: the default export and an exported `<Slug>Props`; the
  first text is `children` and other texts that differ between looks
  are props; `variant` names the product's looks and `interaction`
  the pointer and focus looks (`"rest"` by default); every prop's
  default is the product's default look with its real copy, so `{}`
  renders the default. Elements only some looks have render only in
  those looks. Classes take the product's own names where it has them.
- `<Slug>.module.css`: every value from the page; only what differs
  from the library app's own base is written; the pseudo-class and the
  forced class share one rule (`.root:hover, .root.interaction-hover`);
  the product's @font-face files beside it. Palette colours are stable
  `var(--proto-token-<name>)` references whose values change with the
  library's light/dark switch.
- Pictures, the product's own files beside the module: `image<n>` for
  an `<img>` (the file the browser picked), `picture<n>.svg` for an
  inline `<svg>` (its markup with the product's paints written on,
  set inside the component's `<svg>` as it is; a paint equal to the
  text colour is `currentColor`, so a hover colour still reaches it),
  `picture<n>.png` for a `<canvas>` (its pixels, shown as an `<img>`),
  `background<n>` for a background, mask or list image.
- `component.json`: the states as prop sets with the live element each
  was read from and the width the product gave it, the palette colours
  it uses, and `backdrop`, the
  colour it sits on in the product, which the library paints behind it.

Sharpen it where the tool could not know better: a prop name the
product uses, a variant key its code calls something else. Re-run
`check.mjs` after any change; it must stay matching.

## The queue

During active import work, the library's "Build it" button is a local request
to build a skipped component, and its "Import again" a request to run
the whole import again. `node tools/library.mjs take-queued <codebase>`
pops one request and prints its slug (nothing printed means nothing
queued). A component's slug: survey again, plan that component alone,
run `import.mjs --stage <its-stage>` with it, fix what is left as above,
recomplete this and any invalidated later stage checkpoints, then
`finish-import.mjs <codebase>`. `*`: start this skill over from step 1 (`init` on a
completed run starts fresh). Check the queue after each landing, at
the finish. Do not start a persistent watch or keep the session alive to
consume requests. Later queued work is handled when the user asks to continue
the import in chat; a published library cannot wake an agent.

## Finish

Every line, in order, before you say the import is done:

- all three stage checkpoints are done, in order; every component is either
  built with current passing checks in both themes or explicitly skipped with
  its kind and reason; pending work cannot be counted as complete;
- `node tools/finish-import.mjs <codebase>` validates stage checkpoints,
  current surveys, palette names and checks, then completes and publishes with
  `--wait`. Only `outcome: "published"` confirms completion. Retry publication
  failures with the same command; do not repeat successful imports;
- tell the user all three steps are done and the library is published, with
  the count and names of failed or skipped components;
- check the local component queue once, then continue only into work the user
  already requested. Otherwise finish.

Changes to earlier stages invalidate their completion and later checkpoints.
Repair and recheck the changed stage before proceeding in order again.

## Activity voice

Every activity line, every pass line and every skip reason is read in
the library by the person whose product it is, so it says what
happened in the product's terms: short, present tense, naming the
concrete thing.

- `Reading colours (83 of them)`, `Found 15 components`: what is being
  done, named.
- `Matches the product`, `The corners were 2px too round; tightened`:
  a pass says what was off and what changed, or that nothing differs.
- `The calendar only exists while it is open over the page, so the
  import could not capture it on its own`: a skip says what about the
  product stopped it.

Never `matched rules`, `threshold`, `extracted`, `replica`, `CDP`,
`pixel-verified`, `portal`, a file path, a pixel count or a
percentage: those are your words, not theirs. The headings in the
library are "Type styles", "Colours" and "Components"; use the same
words ("colours", never "color tokens").

## Traps

`docs/cdp-traps.md` holds the rendering traps the tools already handle
and the ones they cannot. Read it before chasing a difference by hand.
