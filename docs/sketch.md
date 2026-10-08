# Sketch first

A new prototype is sketched with the person before it is built. They see
references to react to within seconds, then a few low-fidelity wireframes
that each make one point about their brief, then the moments inside the
one they pick. When they press **Build this**, the sketch is committed and
you build exactly that. The website draws all of it in its sketch studio
from what you report; you never draw pixels.

The person can go back to any step at any time (re-rank, flip to an older
take, pick a different direction). Nothing they did is lost, so treat
every choice as the latest word, not as an error to undo.

Speed is the feature. The person is watching. Something new must appear
within seconds of every choice they make: a status line at once, planned
cards at once, each drawing as soon as it is ready.

All calls go through `node tools/sketch.mjs` (it wraps the `report_sketch`
and `read_sketch` MCP tools). `<id>` below is the brief id.

## 0. Where does it stand?

`get_brief` returns `sketch` for a create-prototype brief:

- `spec` present: the person already pressed Build this (or skipped). Do
  not sketch; go to "Building from the sketch".
- `stage: "none"`: start at step 1.
- anything else: you are resuming. Read `sketch` (or
  `node tools/sketch.mjs read --brief <id>`) and do only what is owed:
  references never posted, `directionsAsked`, a direction whose `refining`
  is set, a take with `drawn: false`, a picked direction without moments.
  Then go to the loop (step 3).

**Never end your turn while sketching.** The person answers in the
studio, not in this chat: if you stop, nothing hears them. Run `wait` in
the foreground (Bash timeout 600000), never in the background, and loop
on it until they commit. Sketchers run in the background and post on
their own; you do not wait for them.

## 1. References (target: on screen within 30 seconds)

1. `node tools/sketch.mjs status --brief <id> "Reading your brief"`, and
   in the same message dispatch the **base wireframe** sketcher in the
   background (step 4 below says what it draws). It must be ready before
   the person has finished ranking.
2. Pick search words from the brief: 2 or 3 `--recent` phrases (what it
   should feel like: "inline warning", "permissions settings", "status
   badge table") and 2 to 4 Mobbin topics
   (`node tools/mobbin.mjs topics --platform web --match "<words>"`,
   instant). Then one command reads both sources in parallel:

   ```
   node tools/sketch.mjs candidates --brief <id> --recent "<words>" --recent "<words>" --mobbin <topic> --mobbin <topic> --limit 8
   ```

   It prints the candidates numbered and writes a contact sheet. **Read
   the sheet** (one picture) and keep only the ones that are actually
   relevant to this brief: the right kind of screen, a pattern the
   person could borrow. Drop gimmicks and anything off-topic even if its
   words matched. Aim for 10 (8 to 12), both sources when both have good
   ones. Fewer good ones beat ten weak ones.
3. Post them as one `references` event. Copy `title`, `app`, `url`,
   `image`, `video`, `width`, `height` from `candidates.json` as they are
   (media must stay on the source's CDN); write a short kebab `id` and a
   `why`: one line on what this one offers *this* brief ("Status sits
   next to each item, so risky tables read at a glance"), never a
   description of the picture.

   ```
   node tools/sketch.mjs post --brief <id> refs.json
   ```
   `refs.json`: `{"type":"references","items":[{"id":"better-stack-settings","source":"mobbin","app":"Better Stack","title":"Settings","url":"…","image":"…","why":"…"}, …]}`
4. The **base wireframe** (dispatched in step 1): one `proto:sketcher`,
   in the background, draws the current
   screen (`referenceUrl`) as `~/.proto/sketches/<id>/base.json`, with no
   highlight and no notes, and an `id` on every region (header, sidebar,
   each section and card, the main column). Every direction is written as
   changes to it, so they all look like the same product and each one is
   quick to write. Then go to the loop.

## 2. The wireframe format

A wireframe is `{ "frame": "desktop" | "mobile", "root": <part> }`, a
layout tree of lo-fi parts. The site lays it out at 1024 by 640 (desktop)
or 375 by 760 (mobile) and draws every part in ink, except the parts
marked `hl`, which it draws in the accent: **the idea**. Notes become
numbered pins on the part with the text beside the drawing.

Parts (`t`), each also taking `id`, `hl`, `note`, `grow`, `w`, `h`:

| t | fields | draws |
|---|---|---|
| `row`, `col` | `children`, `gap` 0-8 (x8px, default 2), `pad` 0-8, `align`, `justify` (`start` `center` `end` `between`), `box` (`line` `soft` `dashed`), `label` | a layout box; `box` gives it an outline or a tint, `label` a small caption |
| `overlay` | `kind` (`modal` `drawer` `sheet` `popover` `toast`), `children`, `title` | floats over the whole page, wherever it sits in the tree |
| `nav` | `items`, `active`, `brand` | a vertical side navigation (use `w`) |
| `text` | `text` (real words) or `lines` (filler bars), `size` (`xs`…`xl`), `muted` | |
| `button` | `label`, `style` (`primary` `secondary` `ghost` `danger`) | |
| `input`, `select`, `search` | `label`, `value` | |
| `toggle`, `checkbox`, `radio` | `label`, `on` | |
| `chip`, `badge` | `label` | |
| `table` | `cols` (header labels), `rows` | |
| `list` | `items` (labels or a count), `leading` (`icon` `avatar` `checkbox`), `trailing` (`chevron` `toggle` `badge` `button`) | |
| `tabs` | `items`, `active` | |
| `chart` | `kind` (`bar` `line` `area` `donut`) | |
| `image` | `ratio` | a crossed box |
| `code` | `lines` | |
| `avatar`, `icon`, `divider`, `spacer` | | `spacer` pushes siblings apart |

Rules that make a wireframe say something:

- **One idea per direction.** Mark it `hl` on 1 to 3 parts. Everything
  else is the existing screen, plain.
- **Notes say why, not what.** 1 to 3 notes, under 70 characters, on the
  parts that carry the idea: "Unprotected tables say so where you work",
  not "A banner with a button".
- **Real words where they matter**: the product's own labels, the new
  copy. Filler is `lines`.
- Keep it lean: 40 to 150 parts. A root `row` with a `nav` (w 56-64), a
  sidebar `col` (w 200-240) and a main `col` with `grow: 1` covers most
  app screens.

Example (a direction for "show which tables have Row Level Security off"):

```json
{"frame":"desktop","root":{"t":"row","gap":0,"align":"stretch","children":[
  {"t":"nav","w":64,"items":["","","","",""],"active":1},
  {"t":"col","w":220,"pad":2,"gap":1,"box":"soft","children":[
    {"t":"search","label":"Search tables"},
    {"t":"list","items":["profiles","orders","invoices"],"leading":"icon"}]},
  {"t":"col","grow":1,"pad":3,"gap":2,"children":[
    {"t":"row","gap":1,"children":[{"t":"text","text":"orders","size":"lg"},{"t":"spacer"},{"t":"button","label":"Insert","style":"primary"}]},
    {"t":"row","box":"line","pad":2,"gap":2,"hl":true,"note":"Unprotected tables say so where you work","children":[
      {"t":"icon"},{"t":"text","text":"Anyone with your anon key can read and write orders","size":"sm","grow":1},
      {"t":"button","label":"Add a policy","style":"primary","note":"Opens the policy, prefilled for this table"}]},
    {"t":"table","cols":["id","customer","total","status"],"rows":6,"grow":1}]}]}}
```

### Changes

A direction or a moment option rarely needs the whole screen written
out: write its `wireframe` as changes to the drawing it starts from, by
part `id`, and `sketch.mjs post` makes it whole before sending:

```json
{"type":"direction","id":"fix-list","title":"Fix-it list","point":"Every problem is its own row with a one-click fix",
 "wireframe":{"from":"base","changes":[
   {"after":"project-header","add":{"t":"col","id":"health","box":"line","pad":2,"hl":true,"note":"Each issue carries its own fix","children":[…]}},
   {"set":"usage","to":{"muted":true}}]}}
```

Changes: `{"replace": id, "with": part}`, `{"after" | "before": id, "add": part}`,
`{"into": id, "add": part, "at": n}`, `{"remove": id}`, `{"set": id, "to": {fields}}`.
`from` is `base` or the file of a take already drawn (`fix-list`), which
is how a moment's options start from the picked take. A wrong id is
refused with the ids that exist.

The site checks every event and refuses a malformed one with the path of
the problem (`event 0 at wireframe.root.children.2…`); fix that and post
again.

## 3. The loop

Run `node tools/sketch.mjs wait --brief <id>`. It blocks until the person
does something (up to 9 minutes; run it again if it returns nothing) and
prints their choices, oldest first. Answer each as below, post a status
line first, and go straight back to `wait`: the sketchers you dispatch
post their own drawings, so never wait for them before waiting on the
person.

| Choice | Answer |
|---|---|
| `ranked` (`picks` best first, with notes) | Plan 3 directions that differ in their *point*, drawn from the top picks and every note. Post `directions-planned` at once (`id`, `title` 2-4 words, `point` one line). Dispatch one `proto:sketcher` per direction, **all in one message, in the background**. A later `ranked` is a new round: plan new directions (new ids); the old ones stay. |
| `more-references` | Search with different words or topics, post a second `references` batch of 4 to 6 new ones. |
| `refine` (`direction` is a take id, `note`) | Dispatch a sketcher to redraw that take with the note: new id `<first-id>-2` (then `-3`), `revises` the take id. |
| `more-directions` (`note`?) | Plan one more direction unlike the others (with the note), post `directions-planned` for it, dispatch a sketcher. |
| `picked` (`direction` is a take id) | Find the 1 or 2 moments where that take could still go more than one way (an empty state, what happens on click, after saving). Post `moments-planned` (`direction` = the take id) at once, then dispatch one sketcher per moment; each posts a `moment` with 2 or 3 options, each with a `label` of 1 to 3 words and a `point` under 60 characters. Picking again re-plans for the new take only if it has no moments yet. |
| `chose` | Nothing to draw; it is part of the spec. |
| `commit` | Stop sketching. Post `{"type":"handed-off","line":"Copying the screen to build on"}` and build (below). |

A sketcher's brief (its prompt) holds: the brief text, the direction
(`id`, `title`, `point`, `borrows` reference ids, and for a refine the
take id it revises and the note) or the moment (`id`, `direction`,
`title`, `question`, the options' labels and points), which drawing it
starts from (`base`, or the take's id for a moment), and this document's
path. It runs `node tools/sketch.mjs base --brief <id>` (or `--from <take id>`)
first, which waits for that drawing and names its part ids, then writes
the event, as changes, to `~/.proto/sketches/<id>/<event-id>.json` and
posts it.

## Building from the sketch

`get_brief`'s `sketch.spec` (also `read_sketch`'s) is what was committed:

- `mode: "skip"`: build from the brief alone, as before.
- `mode: "sketch"`: `direction` (`title`, `point`, `wireframe`, and the
  refine note that produced it), `moments` (each with the chosen option's
  `wireframe`), `references` ranked with the person's notes.

The direction's wireframe is the design: its `hl` parts are the change
to build, its notes are requirements, its labels are the copy. Each
chosen moment option is a state of the prototype to build (a preview
state, step 7). The references say what it should feel like; the
product's own components and styles still decide how it looks. Then run
the create-prototype runbook as written, with this briefId.
