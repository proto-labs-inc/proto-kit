---
name: import-design-system
description: Import your product's design system into Proto. Reads a live page of your product in your own browser, and fills the library with its light and dark colours, type styles and components, each written from the product's own rendering and checked against it pixel for pixel, so prototypes are built from the real thing. Use when setting up a codebase's library, when the user asks to import or sync their design system, or when the library page shows nothing imported.
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
node tools/survey.mjs <codebase> --theme <light|dark>  the visible theme in one read (≈1 s); writes palette.json
node tools/plan.mjs <codebase> '<edits>'            the draft plus your edits → run/plan.json
node tools/import.mjs <codebase> --theme <light|dark>  run the plan: colours, type, inventory, every component
node tools/import.mjs <codebase> --check-theme <light|dark>   check every built component in the visible theme
node tools/snapshot.mjs <codebase> <json | @file> --theme <light|dark>  write one component from its live instances
node tools/check.mjs <codebase> <slug> --theme <light|dark> [--state <name>] [--activity "<line>"]   check it; each pass lands
node tools/explain-diff.mjs <codebase> <slug> --theme <light|dark> [--state <name>]   why a state differs: the product's value and ours, named
node tools/tail.mjs decide <codebase>                 the tail's numbers now, at once: one line to relay when a unit reports; it never waits
node tools/courier-up.mjs <codebase>                this laptop's courier, up and answering (idempotent)
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
   (setup usually started it; it returns at once), then `survey.mjs
   <codebase> --theme light`
   for the page's title and favicon, then `init` (fetch the favicon to
   a file first; leave `--favicon` out when there is none), then
   `publish-library.mjs` in the background. `init` appends "Reading
   the source": the user sees the import is alive in seconds. On
   `tunnel: blocked` the import runs exactly the same (checks use the
   local address, publishing goes over 443); say the serve skill's
   sentence once and carry on. On `tunnel: none` (the site could not be
   reached) the same: the library is up on its local port, every check
   uses it, and `host-library.mjs` shares it when run again later.

   **Listen from here on.** In the same turn, start `node
   tools/courier-up.mjs <codebase>` in the background (`--codex` on
   Codex) and arm the listen skill's watch (its step 1), unless setup
   already did both. `courier-up` does the serve skill's courier steps
   in one call: it registers the courier (once), gets its relay
   address, starts the supervisor, and moves a courier set up by an
   older kit onto the relay. It never prints the secret; do not build
   the courier by hand. Both are light, and from then on the site
   shows this laptop as listening: a Build the user presses mid-import
   lands in the feed and waits its turn (the listen skill's "Busy when
   a command lands").

2. **The page's state and light theme.** If the page is showing
   a welcome screen, an empty list or a sign-in wall instead of the
   product, ask the user one plain question naming what to do ("Open
   a project in the Proto window so its dashboard is showing, then
   tell me") and survey again once they have. Never click in their
   window. The first survey and build use the product's light mode. If
   the page is dark, ask the user to switch it to light first; never
   click the theme control yourself.

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
     "looks": { "checkbox": { "Default": "Checked", "Look 2": "Unchecked" } }
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

4. **Run it.** `node tools/import.mjs <codebase> --theme light` (it reads the plan
   `plan.mjs` wrote).
   It writes the palette, the type styles and the inventory with each
   component's picture, then writes and checks every component, eight
   at a time; each check lands in the library as it is made (the user
   sees the product, the copy and the difference stream in), each
   component that matches in every state lands as built, and the
   library publishes as they land. A component that does not match,
   or could not be written, stays in the library as skipped with the
   product's picture and where it differs, so the library completes
   now; the unit that fixes it lands it as built. It prints what is
   built and what is left to fix, with each failing state's verdict
   and where the difference sits. Matching captured colours are written as stable
   `--proto-token-<name>` variables rather than literals, so the same
   generated component can resolve another theme's values.

   Then ask the user to switch the product page to dark mode. Run
   `node tools/survey.mjs <codebase> --theme dark`, replace the provisional
   dark palette with `node tools/library.mjs tokens <codebase> dark
   @"$HOME/.proto/<codebase>/run/survey/dark/palette.json"`, and run
   `node tools/import.mjs <codebase> --check-theme dark`. The writer and
   `complete` require the light and dark palettes to have the same token
   names. Fix every dark `toFix` result just like a light result; a pass
   records its theme and the library labels it.

5. **The gate, then the tail.** The runner's return is the gate: it
   completed the library itself (`gate.complete`) and left every
   component it could not finish as skipped, with the product's
   picture and its reason (`toFix[].reason`, one line each, printed as
   "<slug> left for later: ..."). Relay the runner's `gate.line` to the
   user as it stands, in one line, then go to the Finish below. The
   import's time is the import's: nothing waits on a unit, you never
   fix a component yourself (not one, not even a small one), and a
   site brief that arrived meanwhile starts right after the Finish.

   Then, for every component in `toFix` or `failed`, dispatch one
   `importer` sub-agent, **all in one turn, in the background**, with
   the brief below. Never pass a model: the importer role runs on the
   fast model by design, and the work is small. Never pass a `name`:
   a named agent becomes a teammate in its own session (under agent
   teams), which does not keep this session's permission mode, so
   every command of theirs asks the user; a plain sub-agent runs in
   this session with its mode.

   Nothing waits on the units. Your next message after the gate is
   the gate line, in the same turn the runner returned, before you
   dispatch anything: the user hears "usable now" the moment it is
   true. From then on `node tools/tail.mjs decide <codebase>` reads the
   units' numbers as they stand and returns at once with one line
   ("Fixing in the background: 13 of 15 matched; the rest improved 2%
   in the last minute, about 4 more minutes to go", or "Moving on: ...,
   a create-prototype command from the site is waiting"). Run it when a
   unit reports or when you are asked where things stand, relay its
   line as it stands, and go on: take the queue and any waiting
   command. Never wait for a unit, never poll, never ask the user
   whether to wait; each unit stops on its own budget (three checks or
   two minutes) and restores its component when it did not match.

   As each unit reports, spot-check it (re-run `check.mjs --theme
   <theme>` on one state) and land it: `status done`, or `status
   skipped` again with its kind, the unit's reason and picture. Publish
   after each landing (the run stays complete; the publish carries the
   change), and say one short line when a component lands this way
   ("Badge now matches the product; the library is republished").

6. **Finish**, per the checklist below, right after step 5's gate;
   every landing after it publishes again.

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
component), the pass pictures show what, and `explain-diff.mjs` says
which value: it reads the product's element and ours at the differing
spots and names each difference (a computed value, a box, a text, a
reference to an id that no longer exists, an image or a face that did
not load, the colour behind the component). Never spend a unit on a
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
> stylesheet, then run `node <kit>/tools/check.mjs <codebase> <slug>
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
> of the page. Write only in the component's folder; never touch
> `public/` or run `library.mjs`. Report as data: done or skipped, each
> state's last verdict, what explain-diff named and what you changed,
> and for a skip the kind (`did-not-match` or `could-not-isolate`),
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
  `found`, `extracting` or `queued` (the runner leaves what it could
  not finish as skipped, with the product's picture and where it
  differs, so this holds the moment it returns);
- `node tools/library.mjs complete <codebase>` (it refuses otherwise);
- `node tools/publish-library.mjs <codebase> --wait`: this last publish
  carries `completedAt`, so the published copy says the import finished;
- the courier is up: `node tools/courier-up.mjs <codebase>` prints
  `local: true` and `relay: "connected"`. If `relay` is anything else,
  say plainly that the site cannot reach this laptop yet, and carry on:
  the import itself does not need it;
- one sentence to the user: the library is published and stays
  viewable after this laptop closes, and how many components are still
  being fixed in the background (each lands and publishes on its own);
- keep listening: take any command that queued up during the import
  (oldest first), then continue into the next thing setup asked for
  (a prototype brief), and keep taking the queue.

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
