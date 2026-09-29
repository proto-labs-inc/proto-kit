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
│   ├── component.json            its states as prop sets, the default first, the tokens it uses, its backdrop
│   └── notes.md                  every value with its source (the unit's working notes)
├── public/
│   ├── manifest.json             everything extracted so far
│   ├── events.jsonl              append-only activity stream; the app tails it
│   ├── queue.json                what the user asked for from the app
│   ├── product/favicon.<ext>     the product page's icon, when the page has one
│   └── components/<slug>/
│       ├── screenshot.png        the product's own picture of the component at 2x (from the inventory on,
│       │                         or once skipped)
│       └── history/<n>.png, <n>-diff.png, <n>-live.png   every pass: our copy, the difference, the product
└── dist/                         the build; what publish uploads
```

## The writer

```
node tools/library.mjs init <library> <codebase> <source> --page-url <url> --page-title "…" [--product-name "…"] [--favicon <file>]
node tools/library.mjs token <library> '<json>'
node tools/library.mjs tokens <library> '<json array>'        many colours, one write
node tools/library.mjs type <library> '<json>'
node tools/library.mjs types <library> '<json array>'         many type styles, one write
node tools/library.mjs inventory <library> '<json array>'     [{ slug, name, screenshot? }]
node tools/library.mjs component <library> <slug> status <found|extracting|done|skipped|queued> [--kind <skipKind>] [--reason "…"] [--screenshot <png>]
node tools/library.mjs history <library> <slug> --screenshot <png> --diff <png> [--live <png>] --mismatch <n> --activity "…"
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
folder is missing a module or `component.json`, a `done` naming a
token the manifest lacks, a `complete` with a component still moving,
an unknown slug) refuses in one sentence and writes nothing. `status
done` is the one call that reads `src/`: it checks the unit's folder
and copies its module path, states and tokens into the manifest, so
the manifest never names a state the app cannot render or a token the
palette lacks.

Every path inside `manifest.json` is relative to `public/`, which is the
app's root: `components/button/screenshot.png`, never `public/…` or `/…`.

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
    "pageTitle": "Expenses · Meridian",                  // that page's <title>, verbatim
    "favicon": "product/favicon.svg"                     // the page's icon, copied into public/ by init --favicon;
                                                         //   only when the page has one: the app heads the library
                                                         //   with it and uses it as its own tab icon
  },
  "startedAt": "…ISO…",           // null until start
  "completedAt": "…ISO…",         // null while anything is still being extracted: this is the done bit;
                                  //   the app dates the import by it
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
      "states": [                     // every state the product shows; the first is the default; empty until done
        { "name": "Default", "props": {} },
        { "name": "Hover", "props": { "hover": true } },
        { "name": "Disabled", "props": { "disabled": true } }
      ],
      "tokens": ["indigo-600", "slate-50", "slate-900"],   // the manifest tokens the component uses,
                                                           //   from its component.json; empty until done
      "backdrop": "oklch(0.215 0.0025 157.5)",  // only when done, from component.json: the colour the component
                                                //   sat on in the product (its painted ancestors composited);
                                                //   the app paints it behind the component everywhere
      "unverified": "…",              // only when done with no passes: one sentence on why, from component.json
      "history": [                    // every verification pass, in order; may be empty
        {
          "at": "…ISO…",
          "activity": "Padding is 2px short on the right; widening",
          "screenshot": "components/button/history/2.png",   // the replica as rendered
          "diff": "components/button/history/2-diff.png",    // the pixel diff against the product
          "live": "components/button/history/2-live.png",    // the product itself for that pass, when the pass has it
          "mismatch": 388                                    // differing pixels (data only: the app never prints a count)
        }
      ],
      "skipKind": "could-not-isolate", // only while skipped or queued: why, one of the kinds below
      "reason": "…",                  // only while skipped or queued: one plain sentence for the user, at most 140 characters
      "screenshot": "components/date-picker/screenshot.png"  // the component cropped from the product at 2x, from the
                                                             //   inventory on (so the library shows it before it is built)
                                                             //   or once skipped; kept through every later status
    }
  ]
}
```

### Component lifecycle

`status` is one of:

- `found`: listed in the inventory, not started. `states`, `tokens` and `history` are empty.
- `extracting`: being read, authored and verified. `history` grows as passes land.
- `done`: `module` names the component, `states` holds one prop set
  per state and `tokens` the names of the manifest tokens it uses,
  all copied from its `component.json`: the default state first, then
  the hover and disabled states where the product has them, then every
  other state the product shows. A component lists as many states as
  the product has, each name used once; a single-state component still
  lists that one state. A done component with no passes carries
  `unverified`, one sentence on why the import made none.
- `skipped`: could not be rebuilt. `skipKind` says which kind of
  failure it was, `reason` says why in one plain sentence in the
  product's own terms (at most 140 characters, no import voice; the
  writer refuses longer) and `screenshot` shows the component cropped to
  its own rect from the live product at 2x (never a viewport shot; the
  writer refuses a skip without it), so the block is not an absence.
  `states` and `tokens` are empty.
- `queued`: the user pressed "Queue it" and the import has taken the request
  (`take-queued`; see queue.json). `skipKind`, `reason` and
  `screenshot` stay, so the block keeps showing what it showed; the
  component goes on to `extracting` (which drops the kind and the
  reason) and then `done` or `skipped` again.

`skipKind` is one of:

- `could-not-isolate`: the component could not be lifted out of the
  page on its own (a portal, a canvas, a state the page never showed).
- `did-not-match`: it was rebuilt but never matched the product
  closely enough in the passes the import spent on it.
- `not-tried`: the import never got to it.

The app groups the not-built strip by kind: the kind is the strip's
heading, the reason its sentence.

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
the last line per component inside that component's block while it moves, and
the whole per-component stream in the "How this was matched" reveal on the
component's page.

### Activity voice

Short present-tense phrases naming the concrete thing, written for
the person whose product it is: `Reading colours (slate-900)`,
`Reading Button on the live page`, `The corners are 2px too round;
tightening`, `Matches the product`, `Found 6 components`. What happened,
in the product's terms; no jargon (no "matched rules", "threshold",
"extracted", "replica", "verified"), no file paths, no percentages.
The writer's own lines follow this too; a `complete` writes
`Finished: 5 of 6 built, 1 skipped`, the one shape the app reads
coverage in everywhere.

## queue.json

```jsonc
{ "requests": [ { "slug": "date-picker", "at": "…ISO…" }, { "slug": "*", "at": "…ISO…" } ] }
```

The app adds a request when the user presses "Queue it" on a skipped
component, and takes it out again when the user cancels before anything
has picked it up. The slug `*` is a request to import everything again,
added by the page's "Import again". The app sends both through one
transport module (`src/courier.ts`); today that is a POST to
`queue.json` on the dev server of `{ "action": "add" | "remove", "slug":
"…" }`, which the site's courier replaces later (MAA-173). A published
build has no server behind it, so there the request fails and the app
says only the live library can ask.

A running import polls the file with `take-queued`, which, for the
first request it can act on, removes the request from `requests` and
prints the slug: for a component's slug it sets the component's `status`
to `queued` and clears `completedAt`; the import then extracts it like
any other component and runs `complete` again when nothing is left in
motion. For `*` it touches nothing else: the import runs `init` again,
which on a completed run starts fresh. A request nothing takes stays in
the file, and the app keeps showing that component as queued (or the
re-import as requested) and says the agent picks it up next time it runs.

## src/components/<slug>/

The component as a prototype will later import it: clean and typed, not
a markup dump.

- `<Slug>.tsx`: one React component, the default export, with an
  exported `<Slug>Props` interface. Every prop has a default that
  produces the product's own default look with real product copy, so
  `{}` renders the default state. States the product reaches with a
  pointer or focus are also props (`hover`, `focused`, `disabled`) that
  force the same look the native `:hover`, `:focus` and `:disabled`
  rules give, so a state renders without a pointer; the forced class
  and the pseudo-class share one rule (`.primary:hover, .primary.hover`).
- `<Slug>.module.css`: the component's whole look, from the read
  values, with the product's mechanisms. Class names are scoped by the
  module; no global rules, no `:root`, nothing outside the component.
  The app's own base styles sit under the component, so the module sets
  every property the product's base sets differently (box-sizing,
  font, line-height, borders). Webfonts are copied beside it and
  declared with `@font-face` in the module.
- `component.json`:

  ```jsonc
  {
    "states": [ { "name": "Default", "props": {} }, … ],  // every state the product shows, the default first, each name once
    "tokens": ["indigo-600", "slate-50", "slate-900"],     // the manifest tokens the component's values come from
    "backdrop": "oklch(0.215 0.0025 157.5)",               // optional: the colour it sits on in the product
    "unverified": "…"                                       // only when no pass was made: one sentence on why
  }
  ```

  A state may also carry `"live": { "selector": "<css>", "force"?:
  "hover" | "focus" | "active" | "focus-visible" }`: the live element
  it was read from and the pseudo-class held on it. `tools/check.mjs`
  checks every state that has one; the app ignores it.

  `status done` copies it into the manifest, and refuses a token the
  manifest does not hold, so push the tokens before landing the unit.
- `notes.md`: the unit's working notes; the app never reads it.

The app finds modules by a glob over `src/components/*/`, so a new
component needs no registry edit, imports each lazily and renders it
live, no iframe. It mounts only the modules of components that are
`done`, plus the one the render route names: the overview block shows
the default state, the component's page one tab per state (with the
state's name in the address, `#/c/<slug>/<state>`, so a state can be
sent), and `#/render/<slug>/<state>?x=&y=&w=` (the state's name as
`component.json` spells it, URL-encoded) mounts one state alone on the
product's surface at those coordinates, reading the state from the
folder's `component.json` rather than the manifest, so a unit verifies
before anything is landed. That route is what the fidelity check
diffs against the live page. A component that throws
shows its error in its own block; nothing else on the page is
affected.

## components/<slug>/history/*.png

The replica screenshot and diff image of every verification pass,
`<n>.png` and `<n>-diff.png`, `n` counting passes from 1 and never
reused. Every pass a component made is kept, however many it took, for
every component, done or skipped: the "How this was matched" reveal on
the component's page opens on the finished pass and steps back through
the earlier ones.

## The choreography

The app polls `manifest.json`, `events.jsonl` and `queue.json` every second
while `completedAt` is null, a request is pending, or any component is not
`done` or `skipped`; it stops otherwise. So the write rhythm IS the user
experience:

1. Append the first event ("Reading the source") before doing anything slow:
   it is what tells the user the import is alive.
1a. Passes land while a component is `extracting`, one per check
   (`tools/check.mjs` lands each as it is made, with the product's
   capture beside ours): the app shows them streaming in the
   component's loading state.
2. Flush `manifest.json` after **every** item (each token, each type style,
   each component transition, each verification pass), and append an event
   for it. The library filling in piece by piece is the product.
3. List all components as `found` as soon as the inventory exists, before
   extracting any: the user sees the full queue up front.
4. Each component walks `found → extracting → done | skipped`, every
   transition flushed. Components may move in parallel. The tokens a
   unit names land before the unit does.
5. A component that cannot be extracted cleanly is `skipped` with a
   `skipKind`, a `reason` and a `screenshot`: never silently dropped,
   never faked.
6. Publish after every landing, `done` or `skipped`: `node
   tools/publish-library.mjs <library>` builds the app and uploads
   `dist/`, so the published library is never more than one component
   behind the one the user is watching. It takes a publish lock of its
   own; a publish asked for while one runs returns at once and the
   running one builds again when it finishes, carrying everything
   landed meanwhile, so landings never queue builds (`--wait` waits
   instead, for the finish). The writer's lock is untouched, so a
   unit's own lines stay instant while a build runs.
7. Finish by running `complete`, which sets `completedAt` and appends
   the coverage line, and publishing once more. Then watch `queue.json`
   for as long as the session lasts.

## What the app tolerates

An empty `events.jsonl`, empty arrays, a partial manifest, a component with
no `history`, a skipped component without a `screenshot` (a blank block takes
its place), a component whose module throws (its block says so). It never tolerates: renamed fields,
different status strings, a `done` component with no `module` or no
states, a `module` outside `src/components/`, paths outside
`components/`, or a token, type style, component or state that
disappears.
