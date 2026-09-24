---
name: import-design-system
description: Import your product's design system into Proto. Reads your codebase and a live page of your product in your own browser, and fills the library with its colors, type styles, and notable components, one of each, so prototypes are built from the real thing. Use when setting up a codebase's library, when the user asks to import or sync their design system, or when the library page shows nothing imported.
---

# Import a design system

You are turning a real product into its design system: the colors,
the type styles, the fonts, and the notable components: buttons,
inputs, badges, the handful of composites the product leans on, each
type appearing **once**, with its states, on a neutral canvas with a
line of realistic sample copy. The page you read is a specimen
catalog of living instances; matching a whole page is
create-prototype's job. The output is the **library contract**
(`docs/library-contract.md`) inside the library app at
`~/.proto/<codebase>/library/`: the user is watching that app fill
in as you write, so the write rhythm is the product, not polish.

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
node tools/library.mjs init <library> <codebase> <source>
node tools/library.mjs token <library> '{"name":"slate-900","value":"#0f172a","group":"gray","role":"text"}'
node tools/library.mjs type <library> '{"name":"Heading L","family":"Inter","size":"24px","weight":650,"lineHeight":"32px","sample":"Expense report: September"}'
node tools/library.mjs inventory <library> '[{"slug":"button","name":"Button","category":"primitive"}, …]'
node tools/library.mjs component <library> <slug> status extracting
node tools/library.mjs history <library> <slug> --screenshot <n>.png --diff <n>-diff.png --mismatch <n> --activity "Padding is 2px short on the right; widening"
node tools/library.mjs state <library> <slug> "Default" <file.html> <height>
node tools/library.mjs component <library> <slug> status done
node tools/library.mjs component <library> <slug> status skipped --reason "<one plain sentence>" --screenshot <crop.png>
node tools/library.mjs event <library> [slug] "<activity>"
node tools/library.mjs take-queued <library>
node tools/library.mjs complete <library>
```

Each call flushes the manifest and appends its own event line, so the
app moves on every call; add an `event` only for something the
default lines do not say. A call that cannot apply refuses in one
sentence and writes nothing.

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
- `node tools/verify-replica.mjs <replica.html|url> <live-tab-url> <x,y,w,h> --out <dir>`:
  one verification pass: captures the live element, renders the
  replica headlessly at the same viewport and ratio, diffs in node,
  writes `<n>-live.png`, `<n>.png`, `<n>-diff.png` into `--out`, prints
  `{ pass, mismatch, pct, maxDelta, clusters, screenshot, diff }`.
- `node tools/cdp/crop.mjs <live-tab-url> <x,y,w,h> <out.png>`: the
  component cropped from the live page at 2x, for a skipped card.
- `node tools/serve.mjs <dir> 0`: a static server on a free port, when
  a replica must be reached by URL rather than by path.

## Where things go

- `~/.proto/<codebase>/library/public/`: the contract files, written
  by `library.mjs` only. Nothing else lands there.
- `~/.proto/<codebase>/imports/<run>/units/<slug>/`: each unit's
  working folder: `notes.md` (every value with its source),
  `replica.html`, the states, fonts, and `passes/` (what
  `verify-replica.mjs` writes). The artifacts are how claims get
  checked, and `history` moves the pass images from here into the
  library.

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
1. **Open the run.** `node tools/library.mjs init <library> <codebase>
   <source>` (`<source>` is the repo name or the live host). This
   appends "Reading the source": the line that tells the user the
   import is alive. Make a run folder
   `~/.proto/<codebase>/imports/<UTC stamp>/units/`.
2. **Read.** The source's component directories, token files and
   font faces; the live page's outline, class names and computed
   styles (see **Reading the page**). Small reads, printed, looked at.
3. **Inventory, flushed at once.** Decide the shelf (see **A curated
   shelf**) and write it in one call: `inventory <library> '[…]'`.
   Every component is `found` and the user sees the whole queue.
   This comes *before* tokens and type styles: the fan-out is the
   critical path and it waits on nothing but this list.
4. **Fan out, in one turn.** Issue every sub-agent spawn in the same
   turn (see **Fan out**), at most four extracting at once; the rest
   start as lanes free up. Mark each `component <slug> status
   extracting` as you spawn it.
5. **Tokens and type styles, while the units run.** Push each token
   and each type style as you confirm it, one `token`/`type` line
   each (chain a dozen in one shell line): the source has the names
   and the grouping, the live page's computed styles arbitrate the
   values, and a disagreement goes in your run notes with the live
   value winning. `role: "surface"` on the page background token and
   `role: "text"` on the page text token, once each. Use real product
   copy for every `sample`.
6. **The courier, while the units run.** If
   `~/.proto/<codebase>/run/courier/` has no `courier.json`, bring
   the courier up now, per the serve skill's "The courier" section.
   It depends only on the codebase id; doing it here, in the window
   where you would otherwise be waiting on sub-agents, is what makes
   the run end when the library does. Landing a report always comes
   first: check for reports between its steps.
7. **Land units as they report.** The moment a report arrives, land
   it before anything else (see **Landing a unit**): a report that is
   not landed is a unit the user never sees finish. The manifest, not
   your memory, is the record of what is done.
8. **Finish**, per the checklist below.

Side errand, once, while the live page is attached: if the codebase
has no icon yet, take the page's `<link rel="icon">` (largest png or
svg) and call `set_codebase_icon { account, codebase, image }` with a
data URL of at most 256 KB. Fail soft; never let it interrupt.

**If anything interrupts you** (the user asks for something else
mid-import, a recovery prompt from the site, a crash, a resumed
session): do that thing, then come back here. `init` again resumes
an open run without touching what is there; read `manifest.json`,
treat every component that is not `done` or `skipped` as still yours,
and carry on from step 4. Never declare the import finished from
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
extraction order. Slugs are lowercase with dashes; names are what the
product's own code calls the thing.

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

Each unit works in its own `units/<slug>/` folder under the run, and
writes only there. The loop:

1. **Find it live.** Locate an instance on the page. Read its
   anatomy: outline, rect, matched rules, the source component file,
   the resolved font (`CSS.getPlatformFontsForNode`). Note which
   states the product shows: the default, and hover and disabled
   where they exist, and anything else visible (selected, error,
   loading, empty). At most six. The rect is the `x,y,w,h` every pass
   uses.
2. **Author the replica.** `replica.html`: the component from read
   values, inline CSS built with *their* mechanisms, rendered at the
   instance's absolute page coordinates (position matters for dash
   phase and gradient dithering; the traps doc says why). Webfonts
   the product uses are copied beside it and declared with
   `@font-face` and a real fallback stack: a preview that silently
   falls back to Helvetica fails the bar.
3. **Verify, one call per pass.** `node tools/verify-replica.mjs
   replica.html <live-tab-url> <x,y,w,h> --out passes`. Read the
   numbers, not the red map: rects must agree exactly (a geometry bug
   is a clean number here and thousands of red pixels in the diff);
   clusters say where. Fix the cause, run the next pass. Stop when
   the mismatch is zero, or when what remains is confined to glyph
   clusters of text set in the system font, which is the two Chromes
   choosing different faces (the traps doc), not your replica. Every
   pass's files stay in `passes/`; the orchestrator moves them into
   the library's history, where the user watches the red drain. Ten
   passes is the cap the library keeps and a reasonable cap for you:
   past it, skip with what you learned as the reason.
4. **Compose the states.** One standalone file per state,
   `default.html` first, then `hover.html`, `disabled.html`, and any
   other the product shows: inline CSS or same-folder assets, no
   build step, no external requests, real copy, sized to show the
   state compactly. Measure each file's rendered height in the
   headless Chrome (`document.documentElement.scrollHeight` after
   fonts load); never guess it. A generative component (a canvas, a
   chart, a p5 sketch) shows several variations side by side in its
   default state file rather than one frozen instance.
5. **Or skip it honestly.** A component you can't isolate cleanly
   (portals, canvas you cannot reproduce, a state you can't reach)
   is skipped: `node tools/cdp/crop.mjs <live-tab-url> <x,y,w,h>
   screenshot.png` for the card, and one plain sentence for the user
   in the product's own terms: what blocked you and whether queueing
   it could work. Never silently dropped, never faked.

State files must stand alone: the app frames them in an iframe at the
recorded height, so the product's styles never touch the library's
own.

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

> Extract `<Name>` (`<slug>`), `<category>`, into
> `<run>/units/<slug>/`. This skill, `docs/cdp-traps.md` and the
> source files are already in your context: do not search for them or
> read them again. Live tab: `<liveUrl>` in the Proto window on port
> 9333, read only; the instance is `<selector>` at `<x,y,w,h>`; the
> states the product shows are `<list>`. Tools, complete signatures:
> `node <kit>/tools/verify-replica.mjs replica.html <liveUrl> <x,y,w,h> --out passes`
> (one pass, prints mismatch and clusters, files in `passes/`);
> `node <kit>/tools/cdp/crop.mjs <liveUrl> <x,y,w,h> screenshot.png`
> (only if you skip); `node <kit>/tools/cdp/headless.mjs` is already
> running on 9444 for measuring state heights. Author from read values
> only; put every value's source in `notes.md`. Never write outside
> your folder; never touch the library. Report, as data: status (done
> or skipped), the states as `name, file, height` in order, each pass
> as `n, mismatch, one activity line` in order, and for a skip the
> reason sentence and the screenshot path.

Do not trust reports: spot-check claims against the artifacts (re-run
a pass, re-read a cited source line) before landing a unit as done.
Verified surprises flow back into your run notes; recurring ones
belong in `docs/cdp-traps.md`.

## Landing a unit

One shell line, chained, the moment the report arrives:

```
node tools/library.mjs history <library> <slug> --screenshot passes/1.png --diff passes/1-diff.png --mismatch 4212 --activity "…" \
&& node tools/library.mjs history <library> <slug> --screenshot passes/2.png --diff passes/2-diff.png --mismatch 0 --activity "…" \
&& node tools/library.mjs state <library> <slug> "Default" units/<slug>/default.html 110 \
&& node tools/library.mjs state <library> <slug> "Hover" units/<slug>/hover.html 110 \
&& node tools/library.mjs component <library> <slug> status done
```

A skip is `component <slug> status skipped --reason "…" --screenshot
units/<slug>/screenshot.png`, after its `history` lines if it made
passes. Then spawn the next waiting component, if any.

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
