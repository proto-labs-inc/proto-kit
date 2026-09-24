---
name: import-design-system
description: Import your product's design system into Proto. Reads your codebase and a live page of your product in your own browser, and fills the library with its colors, type styles, and notable components, one of each, so prototypes are built from the real thing. Use when setting up a codebase's library, when the user asks to import or sync their design system, or when the library page shows nothing imported.
---

# Import a design system

You are turning a real product into its design system: the colors,
the type styles, the fonts, and the notable components: buttons,
inputs, badges, the handful of composites the product leans on, each
type appearing **once**, as a React component with typed props whose
states are prop sets, with a line of realistic sample copy. The page
you read is a specimen catalog of living instances; matching a whole
page is create-prototype's job. The output is the **library
contract** (`docs/library-contract.md`) inside the library app at
`~/.proto/<codebase>/library/`: components in `src/components/`,
everything else in `public/`. The user is watching that app fill in
as you write, so the write rhythm is the product, not polish, and
prototypes will import these components later, so they are clean and
typed, not markup dumps.

Speed is a feature. The first component should be visible in the
library within a minute of the prompt; the whole run for a small page
takes a few minutes, not sixteen. Every slow step in the last real
run was the model writing a program for something the kit now does in
one line. So: **you never write a node script**. Every write goes
through `tools/library.mjs`, every hosting step through
`tools/host-library.mjs`, every verification pass through
`tools/verify-replica.mjs`. If you find yourself composing more than
one line to do one thing, stop: the line exists.

## Two inputs, one output

You have both of these. Use both:

- **The source repo**: path in `~/.proto/<codebase>/codebase.json`.
  This is where names live: token definitions (CSS custom properties,
  Tailwind `@theme`/config, design-token files), font faces, the
  component inventory, and the mechanism behind every look.
- **A live page**: the product page setup recorded
  (`codebase.json`'s `source.liveUrl`), open and signed in in the
  Proto window; setup confirmed the sign-in, so don't ask again. Read
  it over CDP. This is ground truth for values: deployed builds drift
  from checkouts (feature flags, hotfixes, build-time changes). The
  source explains mechanisms; the live page arbitrates values.

When source and live page disagree, the live page wins.

## The one rule

Never invent a value. Every color, size, gap, weight, and wrap in your
output must trace back to something you read: from CDP or from the
source. If you catch yourself estimating a margin from a screenshot,
stop. You have the tools to know. Guessed values look fine until they
break, and when they break you can't tell which guess did it.

This applies to mechanisms too, not just numbers. A button that
spaces its icon with flex `gap` behaves differently from one using a
margin the moment the label wraps. If you use a different mechanism
that lands in the same place today, it drifts tomorrow when content
changes. Copy the component's mechanism.

## Tools

Deterministic helpers. Use them; do not rewrite them; do not read
their source to learn them, the signatures here are complete. (All
`tools/…` paths resolve from the kit root: the installed plugin root
the host exposes (`PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`,
`CURSOR_PLUGIN_ROOT`), otherwise the root above this skill's `skills/`
directory.)

The writer, one line per write (`<library>` is the codebase id or
the app's folder; JSON is a literal or `@file`):

```
node tools/library.mjs init <library> <codebase> <source> --page-url <liveUrl> --page-title "<the page's title, verbatim>"
node tools/library.mjs token <library> '{"name":"slate-900","value":"#0f172a","group":"gray","role":"text"}'
node tools/library.mjs type <library> '{"name":"Heading L","family":"Inter","size":"24px","weight":650,"lineHeight":"32px","sample":"Expense report: September"}'
node tools/library.mjs inventory <library> '[{"slug":"button","name":"Button"}, …]'
node tools/library.mjs component <library> <slug> status extracting
node tools/library.mjs history <library> <slug> --screenshot <n>.png --diff <n>-diff.png --mismatch <n> --activity "Padding is 2px short on the right; widening"
node tools/library.mjs component <library> <slug> status done
node tools/library.mjs component <library> <slug> status skipped --reason "<one plain sentence, at most 140 characters>" --screenshot <crop.png>
node tools/library.mjs event <library> [slug] "<activity>"
node tools/library.mjs take-queued <library>
node tools/library.mjs complete <library>
```

Each call flushes the manifest and appends its own event line, so the
app moves on every call; add an `event` only for something the
default lines do not say. `status done` reads the unit's folder in
`src/components/<slug>/` (the module, its stylesheet, `states.json`)
and copies the module path and the states into the manifest. A call
that cannot apply refuses in one sentence and writes nothing.

The readers and renderers:

- `node tools/host-library.mjs <codebase>`: scaffold, install, tunnel,
  supervised run, edge check, in one call; prints the public and local
  addresses. Idempotent.
- `tools/cdp/chrome.mjs`: the visible Proto window (port 9333), where
  the product page is signed in. You read it, only.
- `tools/cdp/headless.mjs`: the headless Chrome (port 9444) that
  renders every replica. Nothing it draws is on screen.
- `tools/cdp/cdp.mjs`: `connect(wsUrl)`, `evaluate(page, expression)`.
- `tools/cdp/attach.mjs`: `findPage(urlSubstring)`,
  `openBackground(url)`, `navigate(page, url)`, `closePage(tab)`.
- `tools/cdp/wireframe.mjs <tab-url> [out.html]`: the raw layout tree
  as labeled boxes. The map, not the understanding.
- `tools/cdp/capture.mjs`: `stableShot(page, probeExpr, out, clip)`,
  clip screenshots behind the stability gate.
- `node tools/verify-replica.mjs http://localhost:5210 <slug> <state> <live-tab-url> <x,y,w,h> --out <dir>`:
  one verification pass: captures the live element, renders the
  library app's `#/render/<slug>/<state>` (the component alone, at
  those coordinates) headlessly at the same viewport and ratio, diffs
  in node, writes `<n>-live.png`, `<n>.png`, `<n>-diff.png` into
  `--out`, prints `{ pass, mismatch, pct, maxDelta, clusters,
  screenshot, diff }`. The state comes from the unit's `states.json`
  through the app, so it renders before anything is landed.
- `node tools/cdp/crop.mjs <live-tab-url> <x,y,w,h> <out.png>`: the
  component cropped from the live page at 2x, for a skipped card.
- `node tools/serve.mjs <dir> 0`: a static server on a free port, for
  a static folder that must be reached by URL.

## Where things go

- `~/.proto/<codebase>/library/public/`: the manifest, the events,
  the queue, each component's product crop and history, written by
  `library.mjs` only. Nothing else lands there.
- `~/.proto/<codebase>/library/src/components/<slug>/`: the unit's
  folder, and the only place a unit writes: `<Slug>.tsx`,
  `<Slug>.module.css`, the font files, `states.json`, and `notes.md`
  (every value with its source). The app imports it from here, live,
  which is how the render route can show a state before it is landed.
- `~/.proto/<codebase>/imports/<run>/units/<slug>/passes/`: what
  `verify-replica.mjs` writes for the unit; `history` moves the pass
  images from here into the library. The artifacts are how claims get
  checked.

## Setup

Two Chromes, one visible and one not:

- **The Proto window** (`node tools/cdp/chrome.mjs`, port 9333) is
  where the product page is open and the user is signed in; setup
  put it there. You attach and read. Never navigate their tab, never
  open your own pages in this window, never sleep-and-hope. If you
  need the page in a different state, ask them to put it there. Find
  the tab with `findPage(urlSubstring)`; an empty tab list right
  after launch means try again, not broken. Never steal focus: `PUT
  /json/new` raises the window every time, so it is never used.
- **The headless Chrome** (`node tools/cdp/headless.mjs`, port 9444)
  renders every replica and every capture of one. Nothing it draws
  appears on screen. `verify-replica.mjs` starts it when it is not
  running; start it yourself once at the beginning so the first pass
  does not pay for it.

The debug ports give full read access to both Chromes: treat them as
sensitive. Working artifacts from logged-in apps contain real user
data; never commit or share them without a check.

## Order of operations

The order is built so the user sees something within a minute and
the fan-out starts as soon as the inventory exists. Every step is one
call; chain the short ones in one shell line.

0. **Host the library.** `node tools/host-library.mjs <codebase>`.
   Setup usually ran it in the background at codebase creation; run
   it again anyway, it returns at once when the run is up and prints
   the address. The site's Design system page loads that address (the
   one the site chose and stored), so hosting first is what lets the
   user watch. Also `node tools/cdp/headless.mjs start`.
1. **Open the run.** Read the live tab's `document.title`, then
   `node tools/library.mjs init <library> <codebase> <source>
   --page-url <liveUrl> --page-title "<title>"` (`<source>` is the
   repo name or the live host). This appends "Reading the source":
   the line that tells the user the import is alive, and sets the
   product entry: the name is taken from the title ("Expenses ·
   Meridian" names Meridian), and when the page has no title the
   codebase's display name is used, never its id. Make a run folder
   `~/.proto/<codebase>/imports/<UTC stamp>/units/`.
2. **Read.** The source's component directories, token files and
   font faces; the live page's outline, class names and computed
   styles (see **Reading the page**). Small reads, printed, looked at.
3. **The page's state: one question at most.** A page with obvious
   states hides its components behind them: a start button, a sign-in
   wall, an empty list, a welcome screen before the real thing. The
   22 run read the welcome state and skipped both composites for it.
   If the page you read is in a state like that, put it in the
   representative one yourself when a read-only route or hash does it
   (never by clicking in their window), otherwise ask the user one
   plain question naming what to do ("Press Start in the Proto window
   so the garden is showing, then tell me") and wait. Note the state
   in your run notes; every unit reads the same page.
4. **Inventory, flushed at once.** Decide the shelf (see **A curated
   shelf**) and write it in one call: `inventory <library> '[…]'`.
   Every component is `found` and the user sees the whole queue.
   This comes *before* tokens and type styles: the fan-out is the
   critical path and it waits on nothing but this list.
5. **Fan out, in one turn.** Issue every sub-agent spawn in the same
   turn (see **Fan out**), at most four extracting at once; the rest
   start as lanes free up. Mark each `component <slug> status
   extracting` as you spawn it.
6. **Tokens and type styles, while the units run.** Push each token
   and each type style as you confirm it, one `token`/`type` line
   each (chain a dozen in one shell line): the source has the names
   and the grouping, the live page's computed styles arbitrate the
   values, and a disagreement goes in your run notes with the live
   value winning. `role: "surface"` on the page background token and
   `role: "text"` on the page text token, once each. Use real product
   copy for every `sample`.
7. **The courier, while the units run.** If
   `~/.proto/<codebase>/run/courier/` has no `courier.json`, bring
   the courier up now, per the serve skill's "The courier" section.
   It depends only on the codebase id; doing it here, in the window
   where you would otherwise be waiting on sub-agents, is what makes
   the run end when the library does. Landing a report always comes
   first: check for reports between its steps.
8. **Land units as they report.** The moment a report arrives, land
   it before anything else (see **Landing a unit**): a report that is
   not landed is a unit the user never sees finish. The manifest, not
   your memory, is the record of what is done.
9. **Finish**, per the checklist below.

Side errand, once, while the live page is attached: if the codebase
has no icon yet, take the page's `<link rel="icon">` (largest png or
svg) and call `set_codebase_icon { account, codebase, image }` with a
data URL of at most 256 KB. Fail soft; never let it interrupt.

**If anything interrupts you** (the user asks for something else
mid-import, a recovery prompt from the site, a crash, a resumed
session): do that thing, then come back here. `init` again resumes
an open run without touching what is there; read `manifest.json`,
treat every component that is not `done` or `skipped` as still yours,
and carry on from step 5. Never declare the import finished from
memory; the manifest says what is finished.

## A curated shelf, not a census

Pick the **notable** components: the primitives everything is made of
(button, input, badge, and their peers), then the few composites the
product visibly leans on (its card, its table, its page header). The
source's component directories and the live page's class names
(`LemonButton--secondary` names both component and variant) tell you
what exists; your judgment picks what earns a shelf spot: a first
import of a dozen-odd components that renders faithfully beats an
exhaustive one. Primitives first; the inventory order is the
extraction order and the order the library shows. Slugs are lowercase
with dashes; names are what the product's own code calls the thing.

## Reading the page

Work in small reads against the live tab in the Proto window. Each
read is a couple of lines over the websocket. Print the result. Look
at it before deciding the next read. Reads and captures work on the
occluded window (capture forces a frame commit); waiting on anything
that paints does not, which is one reason replicas render headlessly.

1. Outline first. Tag, classes, rect, leaf text, a few levels deep
   from one selector. This tells you the anatomy.
2. Class names carry meaning. Harvest names before anything else.
3. The accessibility tree is free semantics. role=navigation beats any
   heuristic.
4. Matched rules tell you how a look is achieved.
   CSS.getMatchedStylesForNode is the DevTools styles panel as data.
   Use it when you need the mechanism behind a box.
5. Read the component's source file. It answers questions the rendered
   page can't, like why a container wraps at 4 buttons.
6. When source and live page disagree, the live page wins.

Before your first read, and again before your first pixel diff,
read **`docs/cdp-traps.md`**: the accumulated traps of reading and
pixel-verifying live pages. Every one of them was paid for.

## Extracting a component

Each unit works in its own `src/components/<slug>/` folder in the
library app, and writes only there (passes go to its `passes/` folder
under the run). The loop:

1. **Find it live.** Locate an instance on the page. Read its
   anatomy: outline, rect, matched rules, the source component file,
   the resolved font (`CSS.getPlatformFontsForNode`). Note every state
   the product shows: the default, then hover, focus, disabled, open,
   empty and loading where they exist, then everything else it shows
   (selected, error, each named variant and size). List all of them;
   a state the product has and the library lacks is the thing a
   prototype later reaches for and cannot find. The rect is the
   `x,y,w,h` every pass uses.
2. **Author the component.** Three files, the shape a prototype will
   import later:
   - `<Slug>.tsx`: one React component, the default export, with an
     exported `<Slug>Props` interface. Every prop has a default that
     gives the product's own default look with real product copy, so
     `{}` is the default state. The states the product reaches with
     a pointer or focus are props too (`hover`, `focused`,
     `disabled`) that force the look the native `:hover`, `:focus`
     and `:disabled` rules give, so a state renders without a
     pointer. The forced class and the pseudo-class share one rule
     in the module (`.primary:hover, .primary.hover { … }`), so a tab
     shows exactly what a pointer would. Variants the product names (`variant`, `size`, `tone`)
     are typed unions from its class names.
   - `<Slug>.module.css`: the whole look, from read values, with
     *their* mechanisms; class names scoped by the module, no global
     rules, nothing outside the component. The app's base styles sit
     under yours and differ from the product's, so set box-sizing,
     font, line-height and borders explicitly (the traps doc).
     Webfonts the product uses are copied beside it and declared with
     `@font-face` in the module, with a real fallback stack: a
     component that silently falls back to Helvetica fails the bar.
   - `states.json`: `[{ "name": "Default", "props": {} }, …]`, the
     default first, then hover, focus, disabled, open, empty and
     loading where the product has them, then every other state it
     shows. As many as the product has, each name used once.
   A generative component (a canvas, a chart, a p5 sketch) renders
   several variations side by side in its default state rather than
   one frozen instance.
3. **Verify, one call per pass.** `node tools/verify-replica.mjs
   http://localhost:5210 <slug> <state> <live-tab-url> <x,y,w,h>
   --out passes`. It mounts your state alone at the instance's
   absolute coordinates (position matters for dash phase and
   gradient dithering; the traps doc says why) and diffs the clip.
   Read the numbers, not the red map: rects must agree exactly (a
   geometry bug is a clean number here and thousands of red pixels
   in the diff); clusters say where. Fix the cause, run the next
   pass. Stop when the mismatch is zero, or when what remains is
   confined to glyph clusters of text set in the system font, which
   is the two Chromes choosing different faces (the traps doc), not
   your component. Every pass's files stay in `passes/`; the
   orchestrator moves them into the library's history, where the
   user watches the red drain: every pass is kept, so the whole climb
   stays on the page. Ten is a reasonable number of passes to spend on
   one component: past it, skip with what you learned as the reason.
4. **Verify the other states** the same way against their live
   instances where the page shows them (a hovered row, a focused
   field: ask the orchestrator to ask the user only when the state
   cannot be reached without a pointer in their window); a state
   with no live instance is authored from the matched rules and
   noted as unverified in `notes.md`.
5. **Or skip it honestly.** A component you can't isolate cleanly
   (portals, canvas you cannot reproduce, a state you can't reach)
   is skipped: `node tools/cdp/crop.mjs <live-tab-url> <x,y,w,h>
   screenshot.png` for the card, cropped to the component's own rect
   (never the viewport: a page-tall screenshot is not a card), and
   one plain sentence for the user in the product's own terms, at
   most 140 characters, no import voice: "The flowers are drawn with
   p5 on a canvas, which the library cannot rebuild yet", not "could
   not be measured or pixel-verified". `library.mjs` refuses both a
   longer reason and a skip without the crop. Never silently dropped,
   never faked.

The component renders inside the library's own page, no iframe: the
module's scoping is what keeps the product's styles from leaking, so
a global rule in a module is a bug, not a shortcut.

## Fan out: this is a parallel job

Extraction is embarrassingly parallel and the user is watching the
library fill. Dispatch one sub-agent per component, **all spawns in
one turn**, four extracting at a time (the fifth starts when one
reports). Use the cheap importer role: `importer` on Claude Code
(Haiku), `spawn_agent` with `proto-importer` on Codex. Serial
extraction is wrong unless one unit remains.

One orchestrator, you, owns the run and the contract files: **only
you call `library.mjs`**. A sub-agent writes inside its unit folder
and nowhere else, and reports. Its brief is short and complete, in
this shape:

> Extract `<Name>` (`<slug>`) into
> `~/.proto/<codebase>/library/src/components/<slug>/`: `<Slug>.tsx`
> (default export, exported `<Slug>Props`), `<Slug>.module.css`,
> `states.json`, `notes.md`; passes go to `<run>/units/<slug>/passes/`.
> This skill, `docs/cdp-traps.md` and the source files are already in
> your context: do not search for them or read them again. Live tab:
> `<liveUrl>` in the Proto window on port 9333, read only; the
> instance is `<selector>` at `<x,y,w,h>`; the states the product
> shows are `<list>`. Tools, complete signatures:
> `node <kit>/tools/verify-replica.mjs http://localhost:5210 <slug> <state> <liveUrl> <x,y,w,h> --out <run>/units/<slug>/passes`
> (one pass of one state, prints mismatch and clusters);
> `node <kit>/tools/cdp/crop.mjs <liveUrl> <x,y,w,h> screenshot.png`
> (only if you skip, into your passes folder). Author from read
> values only; put every value's source in `notes.md`. Never write
> outside your two folders; never touch `public/` or the manifest.
> Report, as data: status (done or skipped), the states in
> `states.json` order with which were verified, each pass as `n,
> mismatch, one activity line` in order, and for a skip the reason
> sentence (one line, at most 140 characters, in the product's terms)
> and the screenshot path.

Do not trust reports: spot-check claims against the artifacts (re-run
a pass, re-read a cited source line) before landing a unit as done.
Verified surprises flow back into your run notes; recurring ones
belong in `docs/cdp-traps.md`.

## Landing a unit

One shell line, chained, the moment the report arrives:

```
node tools/library.mjs history <library> <slug> --screenshot passes/1.png --diff passes/1-diff.png --mismatch 4212 --activity "…" \
&& node tools/library.mjs history <library> <slug> --screenshot passes/2.png --diff passes/2-diff.png --mismatch 0 --activity "…" \
&& node tools/library.mjs component <library> <slug> status done
```

`done` reads the unit's folder itself and refuses if the module, its
stylesheet or `states.json` is not what the contract says; a refusal
goes back to the unit as one line. A skip is `component <slug> status
skipped --reason "…" --screenshot passes/screenshot.png`, after its
`history` lines if it made passes. Then spawn the next waiting
component, if any.

## The queue

While the session lasts, the library's "Queue it" button is a request
to extract a skipped component. `node tools/library.mjs take-queued
<library>` pops one request and prints its slug (nothing printed
means nothing queued); the component is now `queued` and
`completedAt` is cleared, so the app is watching again. Extract it
like any other unit (a fresh unit folder; the reason it was skipped
is your first clue), land it, `complete`, then build and publish
again. Check the queue after each landing, at the finish, and on
every wake while you listen. A request nothing takes stays in the
file: the card says the agent picks it up next time an import runs,
which is the resumed run's job.

## Finish

Every line, in order, before you say the import is done:

- every component in the manifest is `done` or `skipped`, none
  `found`, `extracting` or `queued`;
- `node tools/library.mjs complete <library>` (it refuses otherwise);
- `pnpm build` in the library folder, then `node tools/publish.mjs
  --kind library --codebase <codebase>`: the library outlives the
  laptop. Start the build while the last unit is being verified if
  you can; it carries whatever `public/` holds when it runs, so build
  again after the last landing;
- the courier is up (`node tools/supervise.mjs status
  ~/.proto/<codebase>/run/courier` shows the listener and tunnel up,
  and a `{"status": true}` POST through the edge answers); step 6
  brought it up, and if it is not, the serve skill's courier section
  is the fix;
- one sentence to the user: the library is published and stays
  viewable after this laptop closes;
- then listen: continue into the next thing setup asked for (a
  prototype brief, or the listen skill), and keep taking the queue.

## Working style

Small steps. One line, run it, look at the output, then continue.
When a result surprises you, chase it before building on it. The
surprises are the product: every entry in `docs/cdp-traps.md` came
from looking at real output instead of assuming.
