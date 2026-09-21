---
name: import-design-system
description: Import a product's design system into the Proto library — tokens, type styles, and components — by reading the linked source repo and a live page in the user's browser through CDP. Use when setting up a product's library, when the user asks to import/sync their design system, or when the library viewer shows an empty library.
---

# Import a design system

You are turning a real product into a library: color tokens, type
styles, and standalone component previews that render faithfully. The
output is the **library contract** — `manifest.json`, `progress.json`,
and `components/*.html` in `~/.proto/<product>/library/` — specified in
`docs/library-contract.md`. Read that first; the user is watching the
viewer fill in as you write, so the write choreography there is not
optional polish, it is the product.

## A design system, not a replica

You are extracting the SYSTEM, not rebuilding the site. The page is a
specimen catalog: it shows you living instances of each component
type. What lands in the library is each type **once** — its variants
side by side, out of page context, on its own — plus the tokens and
type styles underneath everything. Concretely, this import never
produces:

- a rebuilt page, section, or layout — no composite assembly, no page
  chrome, no reproducing how the page arranges things;
- the page's content — a component's example copy is ONE realistic
  invented-or-sampled instance ("Expense report — September"), never
  the page's actual rows, articles, or user data;
- verbatim-copied page markup. Every replica is authored from read
  values; there is no mirror mode here. Copying a page's dense
  content wholesale is a *prototype* concern — when a prototype must
  match a specific page, that's create-prototype's job, with these
  same CDP tools.

If you notice yourself reproducing the page's arrangement or its
text, you've drifted out of this skill's job. Stop, return to the
inventory, extract types.

## Two inputs, one output

You have both of these. Use both:

- **The source repo** — path in `~/.proto/<product>/product.json`.
  This is where names live: token definitions (CSS custom properties,
  Tailwind `@theme`/config, design-token files), font faces, the
  component inventory, and the mechanism behind every look.
- **A live page** — a URL the user has open in their own Chrome,
  logged in, behind their auth. Read it over CDP. This is ground
  truth for values: deployed builds drift from checkouts (feature
  flags, hotfixes, build-time changes). The source explains
  mechanisms; the live page arbitrates values.

When source and live page disagree, the live page wins.

## The one rule

Never invent a value. Every color, size, gap, weight, and wrap in your
output must trace back to something you read — from CDP or from the
source. If you catch yourself estimating a margin from a screenshot,
stop. You have the tools to know. Guessed values look fine until they
break, and when they break you can't tell which guess did it.

This applies to layout mechanisms too, not just numbers. PostHog
centers its hero with two growing spacer divs, not justify-content. If
you use a different mechanism that lands in the same place today, it
drifts tomorrow when content changes. Copy their mechanism.

## Tools

Deterministic helpers live in `tools/cdp/`. Use them. Do not rewrite
them. (All `tools/…` paths in this skill resolve from the kit root:
`${CLAUDE_PLUGIN_ROOT}` when running as the installed proto plugin,
else the proto-kit checkout.)

- `tools/cdp/chrome.mjs` — start (or find) the debug Chrome without
  taking focus.
- `tools/cdp/cdp.mjs` — connect to a CDP websocket; `evaluate()` in a page.
- `tools/cdp/attach.mjs` — find tabs; open background tabs; navigate
  worker tabs.
- `tools/serve.mjs` — static server for your work dir. Serve replica
  and diff pages over http, never file://. This removes canvas taint,
  base64 embedding, and the stale file:// cache trap in one move.
- `tools/cdp/wireframe.mjs` — the raw layout tree as labeled
  depth-colored boxes with a slider. The map, not the understanding.
- `tools/cdp/capture.mjs` — `stableShot()`: clip screenshots behind the
  stability gate (two agreeing probes, then capture, then recheck).
- `tools/cdp/diff.mjs` + `diff.html` — pixel compare in a browser tab;
  read `DIFF_NUMBERS` and `CLUSTERS` out of it.
- `tools/cdp/workspace.mjs` — per-run work folders.

## Where things go

- `~/.proto/<product>/library/` — the contract files only. The viewer
  serves this folder; nothing else lands here.
- `~/.proto/<product>/imports/<run>/` — your working artifacts:
  wireframes, per-component notes, replica iterations, captures,
  diffs. Same layout as a replicate run (`units/<name>/` with
  `notes.md`, `stages/`). Keep every iteration; the artifacts are how
  claims get checked.

## Setup

The user opens the page in their own Chrome, started with a debug port
(`node tools/cdp/chrome.mjs` starts one without taking focus). They log
in themselves. You attach and read. Never launch browsers for them,
never navigate their tabs, never sleep-and-hope. If you need the page
in a different state, ask them to put it there.

Find the tab with one GET to /json/list and match on URL. Chrome takes
a moment after launch to list tabs, so an empty list right after
startup means try again, not broken.

Never steal focus. The user is doing something else while you work.
`PUT /json/new` activates the tab and raises the Chrome window every
time — don't use it. Use `tools/cdp/attach.mjs`: `openBackground()`
creates tabs without raising the window, and `navigate()` on a reused
worker tab never raises focus. Screenshots and reads work on background
and occluded tabs (capture forces a frame commit), so the debug window
can stay minimized the whole session.

The debug port gives full read access to that Chrome — treat it as
sensitive. Working artifacts from logged-in apps contain real user
data; never commit or share them without a check.

## Order of operations

(One side errand while the live page is attached: if the product has
no icon yet — setup skipped it — grab the page's `<link rel="icon">`,
largest png/svg, and call `set_product_icon {account, product,
image}` with a ≤256KB data URL. Fail soft; never let it interrupt
the import.)

0. **Host the library first — before extracting anything.** The
   whole point of the write choreography is that the user WATCHES the
   library fill in; that needs the viewer serving before item one.
   Scaffold `template/library/` into
   `~/.proto/<product>/library/` if setup hasn't, then serve it
   supervised so it outlives this session: a
   `~/.proto/<product>/run/library/` spec running
   `node tools/serve.mjs <library-dir> <port>`, `supervise.mjs
   start`. Tell the user the URL (and the app's design-system page
   picks it up). Only then start the import.

Write `progress.json` **before** doing anything slow — the first
heartbeat ("Reading the source…") is what tells the user the import is
alive. Then, flushing manifest + progress after every item per the
contract:

1. **Tokens.** Harvest definitions from the source (custom properties,
   `@theme` blocks, token files) — the source has the *names* and the
   grouping. Spot-check values against the live page's computed styles;
   where they disagree, the live value wins and the disagreement goes
   in your run notes. Push each token as you confirm it.
2. **Type styles.** Same split: families/weights/scale from the source,
   arbitrated live (`getComputedStyle` on real headings, body text,
   captions). Use real product copy as each style's `sample`.
3. **Inventory.** Build the component list before extracting anything,
   and flush it all at once as `"found"` — the user sees the queue up
   front. Read the source's component directories and package `exports`
   maps; harvest class names from the live page (class identity like
   `LemonButton--secondary` names both component and variant; the
   accessibility tree is free semantics). Split **primitives** (button,
   input, badge) from **composites** (card, table, page header). Order
   the list primitives-first — the contract's viewer shows components
   above colors, and the queue order is the extraction order.
4. **Components, in parallel.** Fan the inventory out to extraction
   subagents (see **Fan out** below); each component still walks
   `found → extracting → done/skipped` with every transition flushed
   by you, as units land. The queue draining several-at-once IS the
   experience the user should see.
5. **Finish.** Set `completedAt`, write
   `{"status": "complete", "activity": "Import complete"}`.

## Reading the page

Work in small reads against the live tab. Each read is a couple of
lines over the websocket. Print the result. Look at it before deciding
the next read.

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

Traps we hit, so you don't:

- display:contents wrappers report a 0x0 rect but their children render. Zero size does not mean empty. Descend anyway.
- Page bounds come from the html element's own rect. Off-screen carousels can extend thousands of pixels past the viewport, so never size anything from the max over all descendants.
- /json/new requires PUT on current Chrome.
- Screenshots come back at device pixel ratio, usually 2x the CSS pixels you asked about.
- svg className is an object, not a string.
- The live viewport can change under you mid-task (the person resizes, a
  sibling agent emulates). A wildly wrong clip usually means the tab
  changed state, not that your replica is bad. Capture, then re-read the
  rect and innerWidth, and retry until two consecutive reads agree.
- Render the replica at the element's absolute page coordinates, not just
  the same fractional phase. Two independent discoveries forced this:
  dashed borders (dash phase accumulates from absolute position) and
  gradients (Skia's dithering is device-position-keyed). Absolute-position
  placement subsumes phase matching — make it the default.
- Verify only after `document.fonts.status === "loaded"` — rect probes
  taken while a woff2 is still loading report plausible-looking
  fallback-font metrics that are all slightly wrong.
- Serialized computed values round: a used line box of 31.9921875px
  serializes as "31.9999px" and tempts you to hardcode 32. Copy the
  authored value (here the unitless line-height var 1.33333), not the
  serialization.
- Computed style is not rendered truth. An element can report a fully
  opaque 1px border in computed style and still rasterize nothing (state
  the style system doesn't surface). When a read and the pixels disagree,
  the pixels win — sample colors from the capture before painting
  something the real page might not paint.
- `img.decode()` never resolves in a background or occluded tab. Wait for
  load events and let `drawImage` decode instead. Same family: anything
  that waits on rendering-side promises can stall in hidden tabs.
- `document.fonts.check()` returns true for families that are not
  installed at all. It answers "would this render something", not "is
  this face available". Trust `document.fonts.status` and rendered
  pixels only.
- Clip to the element's own paint, not its line box. A text element's
  line box can overlap a neighbor's border; the diff then reports the
  neighbor. A thin full-width strip at a clip edge in the cluster output
  means the clip includes a neighbor — shrink the clip, don't chase the
  replica.
- Ancestor compositing is a paint mechanism. A sticky scroller inside a
  `contain: paint` column gets its own composited layer; the layer's
  fractional device origin snaps, SVG mask boxes snap with it, and text
  glyphs absorb the shift instead. Result: icons one device pixel off
  with identical rects and identical styles. If a 1-device-px shift
  survives every per-element fix, reproduce the ancestor stack (sticky +
  overflow + contain + real scroll height), not more styles. Sticky only
  promotes when it has room to move.
- Whitespace text nodes are real. React's `{" "}` emits a separate text
  node; merging it with adjacent text changes glyph shaping by fractions
  of a pixel. Reproduce text node splits (an HTML comment between text
  runs does it).

## Extracting a component

For each inventory entry, in its own `units/<name>/` folder under the
run:

1. **Find it live.** Locate an instance on the page (or ask the user to
   navigate somewhere it appears). Read its anatomy: outline, matched
   rules, the source component file. Note which variants are visible.
2. **Author the replica — always authored, never copied.** Write a
   standalone HTML file: the component's variants side by side, out
   of page context, inline CSS built from read values and *their*
   mechanisms, tokens referenced by the names you extracted, ONE
   realistic sample instance of copy (invented in the product's
   voice, or a single sampled line — never the page's data).
   Authoring is the point: it produces understanding — named
   variants, known mechanisms, values with sources. If a component
   seems to demand copying page markup wholesale, it's probably not
   a component — take it back to the orchestrator as an inventory
   question.
3. **Verify — rects before pixels.** Probe the same landmark rects in
   the live instance and your replica and require exact agreement.
   Geometry bugs surface as clean numbers there; in a pixel diff they
   surface as thousands of red pixels you then have to interpret. Then
   one pixel spot-check: `stableShot()` both at the same absolute
   position, diff, and chase any cluster that indicates a wrong color,
   missing paint, or font substitution. **The v1 bar is: rects exact,
   spot-check clean of structural clusters** — not the full
   zero-pixel loop. Escalate to the full loop (iterate to 0 differing
   pixels at threshold 8) when a component will anchor everything else
   (the button, the input) or when the spot-check keeps surprising you.
4. **Land it.** Copy the verified replica to
   `library/components/<name>.html`, set the entry's `file` and
   `height` (measure the replica's rendered height — don't guess),
   status `"done"`, flush.
5. **Or skip it honestly.** A component you can't isolate cleanly
   (portals, canvas-rendered, needs state you can't reach) becomes
   `"skipped"` with a `reason` written for the user — what blocked
   you, whether a retry could work. Never silently dropped, never
   faked.

Component files must stand alone: inline CSS or same-folder assets, no
build step, no external requests. If the product's fonts are webfonts,
copy the font files into `library/` and `@font-face` them locally with
a real fallback stack — a component preview that silently falls back
to Helvetica fails the "renders faithfully" bar.

## Fan out — this is a parallel job

Extraction is embarrassingly parallel and speed is a feature: the
user is watching the library fill. The curated tree already divides
the work — one component type per unit — so **dispatch one
extraction subagent per unit, all of them at once** (up to whatever
your harness comfortably runs; there is no fixed cap, and serial
extraction is wrong unless only one unit remains). Tokens and type
styles can be a parallel unit of their own alongside the components.

Use cheap, fast models for unit work — the protocol above is
prescriptive enough that they do it well (this was proven during the
protocol's development: the last leaf reached zero on its first
attempt because the skill carried every earlier lesson). On Claude
Code the `importer` agent is preconfigured for this (Haiku); on
Codex, `spawn_agent` with `proto-importer`. Verification of claims
can go to the `verifier`/`proto-verifier` the same way.

One orchestrator — you, the bigger model — owns the run and the
contract files; only you write `manifest.json` and `progress.json`.
Each subagent gets a narrow brief: the target element, this skill,
its own `units/<name>/` folder (the only place it may write). Do not
trust reports: spot-check claims against the artifacts (recompute a
diff, re-read a cited source line) before flushing a unit as done.
Verified surprises flow back into your run notes; recurring ones
belong in this skill's traps list.

## Working style

Small steps. A few lines, run it, look at the output, then continue.
When a result surprises you, chase it before building on it. The
surprises are the product: every trap in this file came from looking at
real output instead of assuming.
