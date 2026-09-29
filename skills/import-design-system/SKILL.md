---
name: import-design-system
description: Import your product's design system into Proto. Reads a live page of your product in your own browser, and fills the library with its colours, type styles and components, each written from the product's own rendering and checked against it pixel for pixel, so prototypes are built from the real thing. Use when setting up a codebase's library, when the user asks to import or sync their design system, or when the library page shows nothing imported.
---

# Import a design system

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

## The one rule

Never invent a value. Every colour, size, gap, weight and wrap comes
from the live page, and the tools take it from there: computed styles
for the look, the product's own declared rules for sizes, margins and
grid tracks, its own @font-face files, its own images. A component
that does not match the product is fixed by reading what differs,
never by nudging numbers until the diff goes quiet.

## Tools

All paths from the kit root (the installed plugin root the host
exposes: `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `CURSOR_PLUGIN_ROOT`;
otherwise the root above this skill's `skills/` directory). Do not
read their source to learn them; the signatures here are complete.

```
node tools/host-library.mjs <codebase>             serve the library (idempotent); prints local:, tunnel:
node tools/library.mjs init <codebase> <codebase> <source> --page-url <url> --page-title "<title>" --favicon <file>
node tools/publish-library.mjs <codebase> [--wait] publish; returns at once when one is running (it carries yours)
node tools/survey.mjs <codebase>                    the page in one read (≈1 s): page, palette, type, candidates
node tools/import.mjs <codebase> <plan.json>        run a plan: colours, type, inventory, every component
node tools/snapshot.mjs <codebase> <json | @file>   write one component from its live instances
node tools/check.mjs <codebase> <slug> [--state <name>] [--activity "<line>"]   check it; each pass lands
node tools/library.mjs component <codebase> <slug> status done
node tools/library.mjs component <codebase> <slug> status skipped --kind <kind> --reason "<sentence>" --screenshot <png>
node tools/library.mjs event <codebase> [slug] "<activity>"
node tools/library.mjs take-queued <codebase>
node tools/library.mjs complete <codebase>
```

The headless Chrome that draws every copy is launched with the Proto
window's own display (its real device scale factor and colour
profile), so a component written from the page matches it to the
pixel. Every tool reads the Proto window and never changes it: no
navigation, no clicks, no focus. Holding a hover or focus look on an
element (`"force"`) is done with the DevTools pseudo-class and let go
straight after.

## Order of operations

1. **Host and open the run**, in one shell line: `host-library.mjs`
   (setup usually started it; it returns at once), then `survey.mjs`
   for the page's title and favicon, then `init` (fetch the favicon to
   a file first; leave `--favicon` out when there is none), then
   `publish-library.mjs` in the background. `init` appends "Reading
   the source": the user sees the import is alive in seconds. On
   `tunnel: blocked` the import runs exactly the same (checks use the
   local address, publishing goes over 443); say the serve skill's
   sentence once and carry on.

2. **The page's state: one question at most.** If the page is showing
   a welcome screen, an empty list or a sign-in wall instead of the
   product, ask the user one plain question naming what to do ("Open
   a project in the Proto window so its dashboard is showing, then
   tell me") and survey again once they have. Never click in their
   window.

3. **Plan.** Read the survey (`~/.proto/<codebase>/run/survey/` holds
   its pictures; look at a few). Write
   `~/.proto/<codebase>/run/plan.json`:
   ```jsonc
   {
     "palette": <survey palette, as is unless a name is wrong>,
     "type": <survey type styles; give each a name the product would use>,
     "components": [
       { "slug": "button", "name": "Button", "picture": "<survey picture>",
         "states": [
           { "name": "Default", "selector": "<instance>" },
           { "name": "Primary", "selector": "<instance of the other look>" },
           { "name": "Hover", "selector": "<instance>", "force": "hover" },
           { "name": "Focus", "selector": "<instance>", "force": "focus-visible" },
           { "name": "Primary hover", "selector": "<instance>", "force": "hover", "of": "Primary" }
         ] } ] }
   ```
   The judgment is yours; the rest is copying selectors:
   - **Exhaustive, not a census.** Every kind of component the page
     shows gets a place: the primitives (buttons, inputs, selects,
     checkboxes, badges, links, avatars, tabs), the fields that pair a
     label with its control, and the composites the product leans on
     (its page header, its panels and cards, its tables, its
     navigation). One component per kind; its other looks are states.
   - **Looks are states.** A survey group with several looks lists one
     instance per look: each is a state, named for what it is in the
     product ("Primary", "Unchecked", "With badge"), the default first.
   - **Interactive components get their pointer and keyboard states**:
     `Hover` (`"force": "hover"`) and `Focus` (`"force":
     "focus-visible"`), and the same for another look with `"of"`.
   - **Names are the product's**: the class names and the text in the
     survey tell you ("LemonButton", "Create new project"), and a quick
     look at the source repo's component folder settles doubts. Slugs
     are lowercase with dashes.
   - Prefer an instance the survey did not mark `cut` (whole on
     screen). Leave out the page's decoration (a promo banner's art),
     hidden native elements and anything 1px wide.

4. **Run it.** `node tools/import.mjs <codebase> ~/.proto/<codebase>/run/plan.json`.
   It writes the palette, the type styles and the inventory with each
   component's picture, then writes and checks every component, eight
   at a time; each check lands in the library as it is made (the user
   sees the product, the copy and the difference stream in), each
   component that matches in every state lands as built, and the
   library publishes as they land. It prints what is built and what
   is left to fix, with each failing state's verdict and where the
   difference sits.

5. **The courier, while it runs.** If
   `~/.proto/<codebase>/run/courier/` has no `courier.json`, bring the
   courier up now (the serve skill's "The courier"), in the minute the
   run takes.

6. **Fix what is left, in parallel.** For every component in `toFix`
   or `failed`, dispatch one `importer` sub-agent, **all in one turn**,
   with the brief below. Never pass a model: the importer role runs on
   the fast model by design, and the work is small. While they run,
   check the queue. As each reports, spot-check it (re-run `check.mjs`
   on one state) and land it: `status done`, or `status skipped` with
   its kind, reason and picture. Publish after each landing.

7. **Finish**, per the checklist below.

If anything interrupts you (a question, a crash, a resumed session):
do that, then come back here. `init` resumes an open run without
touching what is there; `manifest.json` says what is done; run
`import.mjs` again with a plan listing only the components not
`done` or `skipped`.

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
component) and the pass pictures show what. Never spend a unit on a
verdict that counts as matching.

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
> Loop, at most six times: look at the latest pass pictures in
> `~/.proto/<codebase>/run/checks/<slug>/` (`<n>-live.png` is the
> product, `<n>.png` our copy, `<n>-diff.png` the difference); read
> the live element for the value that differs (the Proto window, port
> 9333, read only: `tools/cdp/attach.mjs` findPage and
> `tools/cdp/cdp.mjs` evaluate); fix that value in the module or its
> stylesheet; run `node <kit>/tools/check.mjs <codebase> <slug>
> --activity "<what you changed, in the product's words>"`. If a
> state's live element is the wrong one, correct the plan entry and
> run `node <kit>/tools/snapshot.mjs <codebase> <spec>` again instead.
> Write only in the component's folder; never touch `public/` or run
> `library.mjs`. Report as data: done or skipped, each state's last
> verdict, and for a skip the kind (`did-not-match` or
> `could-not-isolate`), one sentence of at most 140 characters in the
> product's terms, and the survey picture's path.

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
  the product's @font-face files beside it.
- `component.json`: the states as prop sets with the live element each
  was read from, the palette colours it uses, and `backdrop`, the
  colour it sits on in the product, which the library paints behind it.

Sharpen it where the tool could not know better: a prop name the
product uses, a variant key its code calls something else. Re-run
`check.mjs` after any change; it must stay matching.

## The queue

While the session lasts, the library's "Build it" button is a request
to build a skipped component, and its "Import again" a request to run
the whole import again. `node tools/library.mjs take-queued <codebase>`
pops one request and prints its slug (nothing printed means nothing
queued). A component's slug: survey again, plan that component alone,
run `import.mjs` with it, fix what is left as above, then `complete`
and publish. `*`: start this skill over from step 1 (`init` on a
completed run starts fresh). Check the queue after each landing, at
the finish, and on every wake while you listen.

## Finish

Every line, in order, before you say the import is done:

- every component in the manifest is `done` or `skipped`, none
  `found`, `extracting` or `queued`;
- `node tools/library.mjs complete <codebase>` (it refuses otherwise);
- `node tools/publish-library.mjs <codebase> --wait`: this last publish
  carries `completedAt`, so the published copy says the import finished;
- the courier is up (`node tools/supervise.mjs status
  ~/.proto/<codebase>/run/courier` shows the listener and tunnel up,
  and a `{"status": true}` POST through the edge answers);
- one sentence to the user: the library is published and stays
  viewable after this laptop closes;
- then listen: continue into the next thing setup asked for (a
  prototype brief, or the listen skill), and keep taking the queue.

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
