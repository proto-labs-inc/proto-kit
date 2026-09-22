# The library contract

What an import writes into `~/.proto/<codebase>/library/`, and what the
viewer (`template/library/`) reads. **This contract is frozen.** The
fake driver (`tools/fake-import/run.mjs`) is its executable reference —
the real import skill must be indistinguishable from it at the file
level. Change either only together, with the viewer.

## Files

```
library/
├── index.html, viewer.js, viewer.css   the viewer (from template/library/)
├── manifest.json                       everything extracted so far
├── progress.json                       heartbeat: what's happening right now
└── components/*.html                   one standalone HTML file per extracted component
```

## manifest.json

Starts as the template's null/empty shape; grows monotonically during an
import — never rewritten from scratch mid-run.

```jsonc
{
  "codebase": "meridian",          // codebase slug; null until the import starts
  "source": "meridian-web",       // where it came from (repo name / host); null until start
  "startedAt": "…ISO…",           // null until start
  "completedAt": "…ISO…",         // null until the import finishes — this is the done bit
  "tokens": [
    { "name": "indigo-600", "value": "#4f46e5", "group": "brand" }
    // group: freeform bucket the viewer groups swatches by ("gray", "brand", "semantic", …)
  ],
  "type": [
    {
      "name": "Heading L", "family": "Inter", "size": "24px",
      "weight": 650, "lineHeight": "32px",
      "sample": "Expense report — September"   // real copy from the codebase, not lorem
    }
  ],
  "components": [
    {
      "name": "Button",
      "category": "primitive",        // "primitive" | "composite"
      "status": "done",               // "found" → "extracting" → "done" | "skipped"
      "height": 110,                  // px the viewer gives its iframe; defaults to 160
      "file": "components/button.html",  // only when done
      "reason": "…"                   // only when skipped — an honest sentence, shown to the user
    }
  ]
}
```

## progress.json

Overwritten on every step. The viewer polls it (~1s) and shows
`activity` verbatim in the status line.

```jsonc
{
  "status": "importing",            // "importing" | "complete"
  "activity": "Extracting Button…", // present tense, user-facing, specific
  "updatedAt": "…ISO…"
}
```

## components/*.html

Each file is a standalone page rendering that one component: inline CSS
(or same-folder assets), no build step, no external requests. The viewer
iframes it at `height` px. Real product copy in the examples, sized to
show the component's variants compactly.

## The choreography

The viewer re-renders whenever either file's bytes change, so the write
rhythm IS the user experience:

1. Write `progress.json` before doing anything slow — the first
   heartbeat ("Reading the source…") is what tells the user the import
   is alive.
2. Flush `manifest.json` + `progress.json` together after **every
   item** (each token, each type style, each component transition), not
   per phase. The library filling in piece by piece is the codebase.
3. List all components as `"found"` as soon as the inventory exists,
   before extracting any — the user sees the full queue up front.
4. One component at a time: `found → extracting → done/skipped`, each
   transition flushed.
5. A component that can't be extracted cleanly is `"skipped"` with a
   `reason` written for the user (what blocked it, whether you'll
   retry) — never silently dropped, never faked.
6. Finish by setting `completedAt` and writing
   `{"status": "complete", "activity": "Import complete"}`. The viewer
   treats either signal as done; write both.

### Activity voice

Short present-tense phrases naming the concrete thing:
`Extracting color tokens… (slate-900)`, `Extracting Button…`,
`Skipping Date picker`, `Found 6 components`. No jargon, no file paths,
no percentages.

## What the viewer tolerates

Missing `progress.json` (shows "Working…"), missing `height` (160px),
empty arrays, partial manifests. It never tolerates: renamed fields,
different status strings, component files outside `components/`, or a
manifest that shrinks.
