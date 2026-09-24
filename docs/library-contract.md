# The library contract

What an import writes into the library app at `~/.proto/<codebase>/library/`,
and what the app (`template/library/`) reads. **This contract is frozen.**
`tools/library.mjs` is its only writer: every file below is written by
one of its subcommands, and nothing else in the kit (no skill, no
sub-agent, no script an agent composes) touches them. The fake driver
(`tools/fake-import/run.mjs`) plays a recorded import through the same
commands and is the contract's executable reference: the real import
must be indistinguishable from it at the file level. Change the
writer, the driver and the app only together.

The library is a Vite React app (ADR 0003). The import writes two
kinds of thing into it: data into the app's `public/` folder (the
manifest, the activity stream, each component's product crop and
history), and the components themselves as React components with
typed props into `src/components/<slug>/`, which the app imports and
renders directly. Both are live through Vite's dev server while the
import runs, and the built `dist/` (which carries a copy of `public/`
and the compiled components) is what is published.

## Files

```
library/                          the app, scaffolded from template/library/
├── package.json, vite.config.ts, …
├── src/components/<slug>/        the component, authored by the import's unit for it
│   ├── <Slug>.tsx                a React component with a typed props interface, default export
│   ├── <Slug>.module.css         its scoped stylesheet, from the read values; @font-face here
│   ├── *.woff2                   the product's font files, beside the stylesheet
│   ├── states.json               the named states as prop sets, the default first, at most six
│   └── notes.md                  every value with its source (the unit's working notes)
├── public/
│   ├── manifest.json             everything extracted so far
│   ├── events.jsonl              append-only activity stream; the app tails it
│   ├── queue.json                components the user asked for from the app
│   └── components/<slug>/
│       ├── screenshot.png        when skipped: the component cropped from the live page at 2x
│       └── history/<n>.png, <n>-diff.png   the last ten passes' replica captures and diffs
└── dist/                         the build; what publish uploads
```

## The writer

```
node tools/library.mjs init <library> <codebase> <source> --page-url <url> --page-title "…" [--product-name "…"]
node tools/library.mjs token <library> '<json>'
node tools/library.mjs type <library> '<json>'
node tools/library.mjs inventory <library> '<json array>'
node tools/library.mjs component <library> <slug> status <found|extracting|done|skipped|queued> [--reason "…"] [--screenshot <png>]
node tools/library.mjs history <library> <slug> --screenshot <png> --diff <png> --mismatch <n> --activity "…"
node tools/library.mjs event <library> [slug] "<activity>"
node tools/library.mjs take-queued <library>
node tools/library.mjs complete <library>
```

`<library>` is the app's folder or the codebase id. Every call reads
the manifest, applies its one change, writes the manifest back
atomically (temp file, then rename), appends one event line, and
holds a lock across the four steps, so two lanes calling at once
never interleave. Each call is one short shell line and prints the
event it appended; a call that cannot apply (a `done` whose component
folder is missing a module or `states.json`, a `complete` with a
component still moving, an unknown slug) refuses in one sentence and
writes nothing. `status done` is the one call that reads `src/`: it
checks the unit's folder and copies its module path and states into
the manifest, so the manifest never names a state the app cannot
render.

Every path inside `manifest.json` is relative to `public/`, which is the
app's root: `components/button/default.html`, never `public/…` or `/…`.

## manifest.json

Starts as the template's null/empty shape; grows monotonically during an
import, never rewritten from scratch mid-run.

```jsonc
{
  "codebase": "meridian",          // codebase slug; null until the import starts
  "source": "meridian-web",       // where it came from (repo name / host); null until start
  "product": {                    // the product as the live page presents it; null until start
    "name": "Meridian",           // the page title's product name: the app's page heading;
                                  //   a page with no title gives the codebase's display name, never its id
    "pageUrl": "https://app.meridian.example/expenses",  // the live page the import read
    "pageTitle": "Expenses · Meridian"                   // that page's <title>, verbatim
  },
  "startedAt": "…ISO…",           // null until start
  "completedAt": "…ISO…",         // null while anything is still being extracted: this is the done bit
  "tokens": [
    { "name": "slate-50", "value": "#f8fafc", "group": "gray", "role": "surface" },
    { "name": "slate-900", "value": "#0f172a", "group": "gray", "role": "text" },
    { "name": "indigo-600", "value": "#4f46e5", "group": "brand" }
    // group: freeform bucket the app groups swatches by ("gray", "brand", "semantic", …)
    // role: at most one "surface" (the product's page background: the app
    //   paints its page with it) and one "text" (the product's page text:
    //   the app uses it when it reads on the surface, else black or white)
  ],
  "type": [
    {
      "name": "Heading L", "family": "Inter", "size": "24px",
      "weight": 650, "lineHeight": "32px",
      "sample": "Expense report: September"   // real copy from the product, not lorem
    }
  ],
  "components": [
    {
      "slug": "button",               // folder name under src/components/ and public/components/, and the route
      "name": "Button",
      "status": "done",               // see the lifecycle below
      "module": "src/components/button/Button.tsx",   // the component; only once done
      "states": [                     // the first is the default; empty until done; at most six
        { "name": "Default", "props": {} },
        { "name": "Hover", "props": { "hover": true } },
        { "name": "Disabled", "props": { "disabled": true } }
      ],
      "history": [                    // the last ten verification passes, in order; may be empty
        {
          "at": "…ISO…",
          "activity": "Padding is 2px short on the right; widening",
          "screenshot": "components/button/history/2.png",   // the replica as rendered
          "diff": "components/button/history/2-diff.png",    // the pixel diff against the product
          "mismatch": 388                                    // differing pixels
        }
      ],
      "reason": "…",                  // only when skipped: one plain sentence for the user, at most 140 characters
      "screenshot": "components/date-picker/screenshot.png"  // only when skipped: the component cropped from the product at 2x
    }
  ]
}
```

### Component lifecycle

`status` is one of:

- `found`: listed in the inventory, not started. `states` and `history` are empty.
- `extracting`: being read, authored and verified. `history` grows as passes land.
- `done`: `module` names the component and `states` holds one prop set
  per state, copied from its `states.json`: the default first, then the
  hover and disabled states where the product has them, then any other
  state the product shows, at most six. A single-state component still
  lists that one state.
- `skipped`: could not be rebuilt. `reason` says why in one plain sentence
  in the product's own terms (at most 140 characters, no import voice; the
  writer refuses longer) and `screenshot` shows the component cropped to
  its own rect from the live product at 2x (never a viewport shot; the
  writer refuses a skip without it), so the card is not an absence.
  `states` is empty.
- `queued`: the user pressed "Queue it" and the import has taken the request
  (`take-queued`; see queue.json). `reason` and `screenshot` are removed;
  the component goes on to `extracting` and then `done` or `skipped` again.

A component with many natural variations (a generated illustration, a chart)
renders several variations at once in its default state rather than one
frozen instance.

## events.jsonl

One JSON object per line, appended only, never rewritten:

```jsonc
{ "at": "…ISO…", "activity": "Reading the source" }
{ "at": "…ISO…", "component": "button", "activity": "Padding is 2px short on the right; widening" }
```

`component` is the slug the line is about; lines without it are about the
import as a whole. The app shows the last line overall as the page's status,
the last line per component inside that component's card while it moves, and
the whole per-component stream in the "Underneath" reveal on the component's page.

### Activity voice

Short present-tense phrases naming the concrete thing: `Extracting color
tokens (slate-900)`, `Reading Button on the live page`, `Skipping Date
picker`, `Found 6 components`. No jargon, no file paths, no percentages.

## queue.json

```jsonc
{ "requests": [ { "slug": "date-picker", "at": "…ISO…" } ] }
```

The app appends a request when the user presses "Queue it" on a skipped
component (through the dev server; a published build cannot). A running
import polls the file with `take-queued`, which, for the first request
whose slug it knows, removes the request from `requests`, sets the
component's `status` to `queued`, clears `completedAt` and prints the
slug; the import then extracts it like any other component and runs
`complete` again when nothing is left in motion. A request nothing takes
stays in the file, and the app keeps showing that component as queued
and says the agent picks it up next time an import runs.

## src/components/<slug>/

The component as a prototype will later import it: clean and typed, not
a markup dump.

- `<Slug>.tsx`: one React component, the default export, with an
  exported `<Slug>Props` interface. Every prop has a default that
  produces the product's own default look with real product copy, so
  `{}` renders the default state. States the product reaches with a
  pointer or focus are also props (`hover`, `focused`, `disabled`) that
  force the same look the native `:hover`, `:focus` and `:disabled`
  rules give, so a state renders without a pointer.
- `<Slug>.module.css`: the component's whole look, from the read
  values, with the product's mechanisms. Class names are scoped by the
  module; no global rules, no `:root`, nothing outside the component.
  The app's own base styles sit under the component, so the module sets
  every property the product's base sets differently (box-sizing,
  font, line-height, borders). Webfonts are copied beside it and
  declared with `@font-face` in the module.
- `states.json`: `[{ "name": "Default", "props": {} }, …]`, the named
  states as prop sets, the default first, at most six. `status done`
  copies it into the manifest.
- `notes.md`: the unit's working notes; the app never reads it.

The app imports the module lazily and renders it live, no iframe: the
overview block shows the default state, the component's page one tab
per state, and `#/render/<slug>/<state>?x=&y=&w=` mounts one state
alone on the product's surface at those coordinates, which is what the
fidelity check diffs against the live page. A component that throws
shows its error in its own block; nothing else on the page is
affected.

## components/<slug>/history/*.png

The replica screenshot and diff image of every verification pass,
`<n>.png` and `<n>-diff.png`, `n` counting passes from 1 and never
reused. At most ten passes are kept per component: when an eleventh
lands, the oldest entry and its two files go. Kept for every component,
done or skipped: the "Underneath" reveal on the component's page plays
them in order so the mismatch visibly falls.

## The choreography

The app polls `manifest.json`, `events.jsonl` and `queue.json` every second
while `completedAt` is null, a request is pending, or any component is not
`done` or `skipped`; it stops otherwise. So the write rhythm IS the user
experience:

1. Append the first event ("Reading the source") before doing anything slow:
   it is what tells the user the import is alive.
2. Flush `manifest.json` after **every** item (each token, each type style,
   each component transition, each verification pass), and append an event
   for it. The library filling in piece by piece is the product.
3. List all components as `found` as soon as the inventory exists, before
   extracting any: the user sees the full queue up front.
4. Each component walks `found → extracting → done | skipped`, every
   transition flushed. Components may move in parallel.
5. A component that cannot be extracted cleanly is `skipped` with a `reason`
   and a `screenshot`: never silently dropped, never faked.
6. Finish by setting `completedAt` and appending "Import complete". Then
   watch `queue.json` for as long as the session lasts.

## What the app tolerates

An empty `events.jsonl`, empty arrays, a partial manifest, a component with
no `history`, a skipped component without a `screenshot` (a blank block takes
its place), a history whose oldest pass was dropped, a component whose
module throws (its block says so). It never tolerates: renamed fields,
different status strings, a `done` component with no `module` or no
states, a `module` outside `src/components/`, paths outside
`components/`, or a token, type style, component or state that
disappears.
