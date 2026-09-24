# The library contract

What an import writes into the library app at `~/.proto/<codebase>/library/`,
and what the app (`template/library/`) reads. **This contract is frozen.**
The fake driver (`tools/fake-import/run.mjs`) is its executable reference:
the real import skill must be indistinguishable from it at the file level.
Change either only together, with the app.

The library is a Vite React app (ADR 0003). The import never writes
pages: it writes data into the app's `public/` folder, and the app
renders it, live through Vite's dev server while the import runs, and
from the built `dist/` (which carries a copy of `public/`) once published.

## Files

```
library/                          the app, scaffolded from template/library/
├── package.json, vite.config.ts, src/, …
├── public/
│   ├── manifest.json             everything extracted so far
│   ├── events.jsonl              append-only activity stream; the app tails it
│   ├── queue.json                components the user asked for from the app
│   └── components/<slug>/
│       ├── <state>.html          one standalone page per state
│       ├── screenshot.png        when skipped: a crop of the real product
│       └── history/*.png         iteration screenshots and diff images
└── dist/                         the build; what publish uploads
```

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
    "name": "Meridian",           // the page title's product name: the app's page heading
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
      "slug": "button",               // folder name under components/ and the route
      "name": "Button",
      "category": "primitive",        // "primitive" | "composite"
      "status": "done",               // see the lifecycle below
      "states": [                     // the first is the default; empty until extracted
        { "name": "Default", "file": "components/button/default.html", "height": 110 },
        { "name": "Hover", "file": "components/button/hover.html", "height": 110 }
      ],
      "history": [                    // every verification pass, in order; may be empty
        {
          "at": "…ISO…",
          "activity": "Padding is 2px short on the right; widening",
          "screenshot": "components/button/history/2.png",   // the replica as rendered
          "diff": "components/button/history/2-diff.png",    // the pixel diff against the product
          "mismatch": 388                                    // differing pixels
        }
      ],
      "reason": "…",                  // only when skipped: one plain sentence for the user
      "screenshot": "components/date-picker/screenshot.png"  // only when skipped: the real product
    }
  ]
}
```

### Component lifecycle

`status` is one of:

- `found`: listed in the inventory, not started. `states` and `history` are empty.
- `extracting`: being read, authored and verified. `history` grows as passes land.
- `done`: `states` holds one entry per state, the default first. A single-state
  component still lists that one state.
- `skipped`: could not be rebuilt. `reason` says why in the product's own terms
  and `screenshot` shows the component cropped from the live product, so the
  card is not an absence. `states` is empty.
- `queued`: the user pressed "Queue it" and the import has taken the request
  (see queue.json). `reason` and `screenshot` are removed; the component goes
  on to `extracting` and then `done` or `skipped` again.

A component with many natural variations (a generated illustration, a chart)
shows several variations at once in its default state file rather than one
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
component (through the dev server; a published build cannot). The import
polls the file, and for each request whose slug it knows: removes the
request from `requests`, sets the component's `status` to `queued`, clears
`completedAt`, and extracts it like any other component, setting
`completedAt` again when nothing is left in motion. A request the import
does not take stays in the file, and the app keeps showing that component
as queued.

## components/<slug>/<state>.html

Each file is a standalone page rendering that one state of the component:
inline CSS (or same-folder assets), no build step, no external requests. The
app frames it in an iframe at `height` px, so the product's styles never
touch the app's own. Real product copy, sized to show the state compactly.
Webfonts the product uses are copied beside the file and declared with
`@font-face` there.

## components/<slug>/history/*.png

The replica screenshot and diff image of every verification pass, named by
the manifest's `history` entries (`<n>.png`, `<n>-diff.png` by convention).
Kept for every component, done or skipped: the "Underneath" reveal on the
component's page plays them in order so the mismatch visibly falls.

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
its place). It never tolerates: renamed fields, different status strings, a
`done` component with no states, paths outside `components/`, or a manifest
that shrinks.
