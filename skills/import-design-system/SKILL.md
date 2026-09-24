---
name: import-design-system
description: Import your product's design system into Proto. Reads your codebase and a live page of your product in your own browser, and fills the library with its colors, type styles, and notable components, one of each, so prototypes are built from the real thing. Use when setting up a codebase's library, when the user asks to import or sync their design system, or when the library page shows nothing imported.
---

# Import a design system

You are turning a real product into its design system: the colors,
the type styles, the fonts, and the notable components: buttons,
inputs, badges, the handful of composites the product leans on, each
type appearing **once**, its variants side by side on a neutral
canvas with a line of realistic sample copy. The page you read is a
specimen catalog of living instances; matching a whole page is
create-prototype's job. The output is the **library contract**:
`public/manifest.json`, `public/events.jsonl` and
`public/components/<slug>/<state>.html` inside the library app at
`~/.proto/<codebase>/library/`, specified in
`docs/library-contract.md`. Read that first; the user is watching the
library fill in as you write, so the write choreography there is not
optional polish, it is the product.

## Two inputs, one output

You have both of these. Use both:

- **The source repo**: path in `~/.proto/<codebase>/codebase.json`.
  This is where names live: token definitions (CSS custom properties,
  Tailwind `@theme`/config, design-token files), font faces, the
  component inventory, and the mechanism behind every look.
- **A live page**: the product page setup recorded
  (`codebase.json`'s `source.liveUrl`), open and logged in in the
  Proto window; setup confirmed the login, so don't ask again. Read it over CDP. This is ground
  truth for values: deployed builds drift from checkouts (feature
  flags, hotfixes, build-time changes). The source explains
  mechanisms; the live page arbitrates values.

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

Deterministic helpers live in `tools/cdp/`. Use them. Do not rewrite
them. (All `tools/…` paths in this skill resolve from the kit root.
Prefer the installed plugin root exposed by the host (`PLUGIN_ROOT`,
`CLAUDE_PLUGIN_ROOT`, or `CURSOR_PLUGIN_ROOT`); otherwise use the root
above this skill's `skills/` directory, which is also the proto-kit
checkout root.)

- `tools/cdp/chrome.mjs`: start (or find) the visible Proto window
  without taking focus. The product page lives there; you read it.
- `tools/cdp/headless.mjs`: start (or find) the headless Chrome that
  renders every replica; `headlessPage(url, { width, height, dpr })`
  from code. Nothing it draws is ever on screen.
- `tools/cdp/cdp.mjs`: connect to a CDP websocket; `evaluate()` in a page.
- `tools/cdp/attach.mjs`: `findPage(urlSubstring)` on the visible
  window; `openBackground()` and `navigate()` for tabs the kit opened.
- `tools/cdp/wireframe.mjs`: the raw layout tree as labeled
  depth-colored boxes with a slider. The map, not the understanding.
- `tools/cdp/capture.mjs`: `stableShot()`, clip screenshots behind the
  stability gate (two agreeing probes, then capture, then recheck);
  the clip is cut in node, never by Chrome.
- `tools/verify-replica.mjs <replica> <live-tab-url> <x,y,w,h>`: one
  verification pass in one call: captures the live element, renders
  the replica headlessly at the same viewport and ratio, diffs in
  node, writes `<n>-live.png`, `<n>.png`, `<n>-diff.png` and prints
  the mismatch and clusters. Nobody writes a diff page.
- `tools/cdp/crop.mjs <live-tab-url> <x,y,w,h> <out.png>`: the
  component cropped from the live page at 2x, for a skipped card.
- `tools/serve.mjs <dir> 0`: static server on a free port, when a
  replica needs to be reached by URL rather than by path.

## Where things go

- `~/.proto/<codebase>/library/`: the library app. You write only
  into its `public/` folder, and only the contract files; nothing
  else lands there.
- `~/.proto/<codebase>/imports/<run>/`, your working artifacts:
  wireframes, and one `units/<name>/` per component with `notes.md`,
  captures, and diffs. The artifacts are how claims get checked.

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

(One side errand while the live page is attached: if the codebase has
no icon yet, setup skipped it, grab the page's `<link rel="icon">`,
largest png/svg, and call `set_codebase_icon {account, codebase,
image}` with a ≤256KB data URL. Fail soft; never let it interrupt
the import.)

0. **Host the library first, before extracting anything.** The
   whole point of the write choreography is that the user WATCHES the
   library fill in; that needs the library app reachable from the site
   before item one. Reachable means through its tunnel, not on
   localhost: the app's Design system page loads the address the site
   returns and stores when the library's tunnel is provisioned,
   nothing else. If the library is already running under supervision
   (a `run/library/` with a live daemon), leave it; otherwise, in this
   order:
   1. Scaffold `template/library/` into `~/.proto/<codebase>/library/`
      if setup hasn't (skip when its `public/manifest.json` already
      has content), then `pnpm install --frozen-lockfile` there. The
      library is a Vite React app (ADR 0003); the install is paid
      once per codebase.
   2. **Provision the tunnel before anything can look the name up**:
      call the `provision_tunnel` MCP tool with
      `{ kind: "library", codebase: "<codebase>", port: <port> }`. The
      site chooses the address, creates the DNS record, stores the
      address on the codebase's row, and returns it as `url` with its
      bare `hostname` and the `connectorToken`; never build the
      address yourself. It must happen before the site, a browser, or
      you ever ask for that hostname: a lookup that finds no record is
      remembered as "does not exist" by every resolver on the path
      for thirty minutes, and the library will look dead long after
      it is up. Never `curl https://<hostname>` before this step.
   3. Write the `~/.proto/<codebase>/run/library/` spec with **three**
      processes, exactly as the serve skill's "The library" section
      shows: Vite's dev server (`pnpm dev` in the library folder with
      `PROTO_TUNNEL=1`; the port is the one in its `vite.config.ts`,
      5210, and is what you passed to `provision_tunnel`), the tunnel
      connector from the provisioning result, and the liveness beat
      `node tools/prototype-heartbeat.mjs --kind library <run-dir>
      <codebase>`. Then `supervise.mjs start`. A library run without a
      tunnel process is a bug: the beat stays silent without one, so
      the site would never call it live anyway.
   4. Verify through Cloudflare's edge only, once: `curl --resolve
      <hostname>:443:<edge ip> https://<hostname>/manifest.json`
      (any IP from `dig @1.1.1.1 <hostname> A`). A plain `curl` or
      opening the hostname in a browser is a resolver lookup, and if
      it races the record it poisons this laptop for thirty minutes.
      Then tell the user the URL. Only then start the import.

Append the first event to `public/events.jsonl` **before** doing
anything slow: that line ("Reading the source") is what tells the user
the import is alive. The same first flush of the manifest sets
`codebase`, `source`, `startedAt` and `product`: the live page's
address, its `<title>` verbatim, and the product's name taken from
that title ("Expenses · Meridian" names Meridian), which is the
library's page heading. Then, flushing the manifest and appending an event
after every item per the contract:

1. **Tokens.** Harvest definitions from the source (custom properties,
   `@theme` blocks, token files): the source has the *names* and the
   grouping. Spot-check values against the live page's computed styles;
   where they disagree, the live value wins and the disagreement goes
   in your run notes. Push each token as you confirm it.
2. **Type styles.** Same split: families/weights/scale from the source,
   arbitrated live (`getComputedStyle` on real headings, body text,
   captions). Use real product copy as each style's `sample`.
3. **Inventory: a curated shelf, not a census.** Build the component
   list before extracting anything, and flush it all at once as
   `"found"`: the user sees the queue up front. Pick the
   **notable** components: the primitives everything is made of
   (button, input, badge, and their peers), then the few composites
   the product visibly leans on (its card, its table, its page
   header). The source's component directories and the live page's
   class names (`LemonButton--secondary` names both component and
   variant) tell you what exists; your judgment picks what earns a
   shelf spot: a first import of a dozen-odd components that
   renders faithfully beats an exhaustive one. Order primitives
   first; the queue order is the extraction order.
4. **Components, in parallel.** Fan the inventory out to extraction
   subagents (see **Fan out** below); each component still walks
   `found → extracting → done/skipped` with every transition flushed
   by you, as units land. The queue draining several-at-once IS the
   experience the user should see. **The moment a subagent reports
   back, flush that unit's status before doing anything else.** A
   report that arrives and is not flushed is a unit the user never
   sees finish; the manifest, not your memory, is the record of what
   is done.
5. **Finish. Every line of this list, in order, before you say the
   import is done:**
   - every component in the manifest is `done` or `skipped` (none
     `found` or `extracting`);
   - `completedAt` is set and the last event says "Import complete";
   - the library is published so it outlives the laptop: build it
     first (`pnpm build` in `~/.proto/<codebase>/library/`; the build
     carries a copy of `public/`), then
     `node tools/publish.mjs --kind library --codebase <codebase>`;
   - keep watching `public/queue.json` for as long as the session
     lasts: a "Queue it" from the library page is a request to extract
     a skipped component (the contract says how to take it), and a
     component that lands afterwards means building and publishing
     again;
   - one line to the user: the library is published and stays
     viewable after this laptop closes;
   - then continue into the next thing setup asked for (a prototype
     brief, or the listen skill). The import is not done until the
     list is.

**If anything interrupts you** (the user asks for something else
mid-import, a recovery prompt from the site, a crash, a resumed
session): do that thing, then come back here. Read `manifest.json`,
treat every component that is not `done` or `skipped` as still
yours, and carry on from step 4. Never declare the import finished
from memory; the manifest says what is finished.

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

For each inventory entry, in its own `units/<name>/` folder under the
run:

1. **Find it live.** Locate an instance on the page (or ask the user to
   navigate somewhere it appears). Read its anatomy: outline, matched
   rules, the source component file. Note which variants are visible.
2. **Author the replica.** Write the component from read values:
   inline CSS built with *their* mechanisms, tokens referenced by the
   names you extracted, a line of realistic sample copy in the
   product's voice. Authoring is the point: it produces
   understanding, named variants, known mechanisms, values with
   sources.
3. **Verify each variant against its live instance, the full
   loop.** Render the authored variant at the instance's absolute
   page coordinates in a verification page (`docs/cdp-traps.md`
   tells you why position matters and what will bite). Probe the
   same landmark rects in both and require exact agreement:
   geometry bugs surface as clean numbers there; in a pixel diff
   they surface as thousands of red pixels you then have to
   interpret. Then `stableShot()` both, diff, debug from the numbers
   (clusters, sampled pixels), and iterate until clean at threshold
   8. A component-sized clip makes this loop fast; zero is
   reachable and components this small earn it.
4. **Compose and land the states.** Write each verified state as a
   standalone `public/components/<slug>/<state>.html`, the default
   first, and push each onto the entry's `states` with its `file` and
   `height` (measure the rendered height: don't guess); then status
   `"done"`, flush.
5. **Or skip it honestly.** A component you can't isolate cleanly
   (portals, canvas-rendered, needs state you can't reach) becomes
   `"skipped"` with a `reason` written for the user (what blocked
   you, whether a retry could work) and a `screenshot` cropped from
   the live product into `public/components/<slug>/screenshot.png`.
   Never silently dropped, never faked.

State files must stand alone: inline CSS or same-folder assets, no
build step, no external requests. If the product's fonts are webfonts,
copy the font files into the component's folder and `@font-face` them
locally with a real fallback stack: a component preview that silently falls back
to Helvetica fails the "renders faithfully" bar.

## Fan out: this is a parallel job

Extraction is embarrassingly parallel and speed is a feature: the
user is watching the library fill. The curated tree already divides
the work, one component type per unit, so **dispatch one
extraction subagent per unit, all of them at once** (up to whatever
your harness comfortably runs; there is no fixed cap, and serial
extraction is wrong unless only one unit remains). Tokens and type
styles can be a parallel unit of their own alongside the components.

Use cheap, fast models for unit work: the protocol is prescriptive
enough that they do it well. On Claude Code the `importer` agent is
preconfigured for this (Haiku); on Codex, `spawn_agent` with
`proto-importer`. Verification of claims can go to the
`verifier`/`proto-verifier` the same way.

One orchestrator, you, the bigger model, owns the run and the
contract files; only you write `manifest.json` and `events.jsonl`.
Each subagent gets a narrow brief: the target element, this skill,
its own `units/<name>/` folder (the only place it may write). Do not
trust reports: spot-check claims against the artifacts (recompute a
diff, re-read a cited source line) before flushing a unit as done.
Verified surprises flow back into your run notes; recurring ones
belong in `docs/cdp-traps.md`.

## Working style

Small steps. A few lines, run it, look at the output, then continue.
When a result surprises you, chase it before building on it. The
surprises are the product: every entry in `docs/cdp-traps.md` came
from looking at real output instead of assuming.
