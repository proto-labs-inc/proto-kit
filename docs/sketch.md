# Sketch first

A new prototype is sketched with the person before it is built. They see
references to react to within seconds, then a few low-fidelity wireframes
that each make one point about their brief, then the details inside the
one they pick. When they press **Build this**, the sketch is committed and
you build exactly that. The website draws all of it in its sketch studio
from what you report; you never draw pixels.

The person can go back to any step at any time (re-rank, flip to an older
take, pick a different direction). Nothing they did is lost, so treat
every choice as the latest word, not as an error to undo.

A sketch happens only when the brief asks for it: `brief.inputs.sketch`
is true (the person left "Sketch it first?" on). Otherwise build straight
away.

**Write every line the person reads in ASD-STE100 Simplified Technical
English**: titles, points, notes, status lines. Short sentences (at most
20 words, a note at most 12), active voice, one idea per sentence, common
words, no idioms or marketing words. "Status sits next to each table." not
"Status is elegantly surfaced in context, so risky tables pop."

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
  is set, a take with `drawn: false`, a picked direction without details.
  Then go to the loop (step 3).

**Never end your turn while sketching.** The person answers in the
studio, not in this chat: if you stop, nothing hears them. Run `wait` in
the foreground (Bash timeout 600000), never in the background, and loop
on it until they commit. If the person pastes a sketch prompt from the
website instead (it carries one step and everything chosen so far, for
when you were not waiting), do that step, unless the stream shows you
already did it, then go back to `wait`. Sketchers run in the background and post on
their own; you do not wait for them.

## 1. References

Reference retrieval now uses the server-side workflow in `docs/variant-references.md`.
Register the variant set, capture the current product, and run `reference-research.mjs`.
Show its progress, inspect the ranked selection and register the saved references in
the variant set's normal References gallery. The historical sketch reference-event
format is not the route for new multi-source research. Keep supplied references.
Do not call local `mobbin.mjs`, `recent.mjs`, or `sketch.mjs candidates` for research.

Draw the base wireframe from the current screen, then continue with the wireframe
format and refinements below. Read the product palette using `sketch.mjs palette`
when needed. References remain in the normal variant-set gallery.

## 2. The wireframe format

A wireframe is `{ "frame": "desktop" | "mobile", "root": <part> }`, a
layout tree of lo-fi parts. The site lays it out at 1024 by 640 (desktop)
or 375 by 760 (mobile) and draws every part in ink, except the parts
marked `hl`, which it draws in the accent: **the idea**. Notes become
numbered pins on the part with the text beside the drawing.

Parts (`t`), each also taking `id`, `hl`, `note`, `grow`, `w`, `h` and
`tone`:

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

- **No gray framing.** Draw wireframes edge to edge on a white or transparent canvas. Do not add gray backgrounds, gray insets, outer mats, or decorative page frames. Do not wrap the root in a soft box or add padding to simulate an inset page.

- **Colour only when it is the point.** A wireframe is ink and one accent.
  When the brief or a note is about colour ("Restore is red"), give that
  part `tone` (`red`, `green`, `amber`, `blue`): it is drawn in that
  colour, even when it is also highlighted.

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

A direction or a detail option rarely needs the whole screen written
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
is how a detail's options start from the picked take. A wrong id is
refused with the ids that exist.

`sketch.mjs post` maps common names to these parts before sending
(`card` is a boxed `col`, `heading` a large `text`, `dialog` an `overlay`)
and draws any other name as a dashed box labelled with it, so a drawing is
never refused for a word. The base is never posted: it only exists as
`base.json`, written once.

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
| `ranked` (`picks` best first, with notes) | Plan 3 directions that differ in their *point*, each built on 1 or 2 of the top picks and their notes (the person's notes win over yours). Post `directions-planned` at once (`id`, `title` 2-4 words, `point` one line). Dispatch one `proto:sketcher` per direction, **all in one message, in the background**. A later `ranked` is a new round: plan new directions (new ids); the old ones stay. |
| `more-references` | Search with different words or topics, post a second `references` batch of 4 to 6 new ones. |
| `refine` (`direction` is a take id, `note`) | Dispatch a sketcher to redraw that take with the note: new id `<first-id>-2` (then `-3`), `revises` the take id. Change only what the note asks; keep the direction's own idea. |
| `more-directions` (`note`?) | One more direction. **With a note, the note is its idea**: its title and point say it in the person's words ("Restore is red" becomes "Red Restore" / "Restore stands out in red") and the drawing shows exactly that, nothing else new. Without a note, invent an idea none of the shown directions try. Post `directions-planned` for it at once, then dispatch a sketcher. |
| `picked` (`direction` is a take id) | Find the 1 or 2 details where that take could still go more than one way (an empty state, what happens on click, after saving). Post `details-planned` (`direction` = the take id) at once, then dispatch one sketcher per detail; each posts a `detail` with 2 or 3 options, each with a `label` of 1 to 3 words and a `point` under 60 characters. Picking again re-plans for the new take only if it has no details yet. |
| `chose` | Nothing to draw; it is part of the spec. |
| `commit` | Stop sketching. Post `{"type":"handed-off","line":"Copying the screen to build on"}` and build (below). |

A sketcher's brief (its prompt) holds: the brief text, what to borrow
(each borrowed reference's title, image address, and the person's note
on it), the direction
(`id`, `title`, `point`, `borrows` reference ids, and for a refine the
take id it revises and the note) or the detail (`id`, `direction`,
`title`, `question`, the options' labels and points), which drawing it
starts from (`base`, or the take's id for a detail), and this document's
path. It runs `node tools/sketch.mjs base --brief <id>` (or `--from <take id>`)
first, which waits for that drawing and names its part ids, then writes
the event, as changes, to `~/.proto/sketches/<id>/<event-id>.json` and
posts it.

## References for variants

A variant set can start from references alone. The person picks an
element in the Frame, writes how to vary it, turns **References** on and
copies the prompt. The brief is `add-variants` with `inputs.references`
true. `prototype_slug` names the prototype and `section` names the
element (its `data-proto-id`). The Frame's sidebar shows what you report,
and the person picks there.

1. `report_progress started`, then `sketch.mjs status --brief <id> "Looking at the prototype"`.
2. Look at the element: `public/prototype.json`, and the element in the
   workspace (`~/.proto/<codebase>/prototypes/<slug>/`: `src/frozen/page.html`
   by its marker, or `src/change/`). Decide what kind of component it is
   and what the brief wants to vary. Spend under a minute on this.
3. Find references for that component and the brief, exactly as in
   step 1 above (`candidates`, read the sheet, keep 6 to 10 that fit,
   write `notes`, post one `references` event). Then post the status
   line "Pick the references you like."
4. Wait with `sketch.mjs wait`, in the foreground, in a loop. On
   `more-references`, post a second batch. On `commit` with `mode`
   `references` (a `ranked` choice comes just before it), build.
5. Build the set from the ranked references and the person's notes:
   - **No set yet for the element:** use the create-variant-set skill.
     Make 2 to 4 variants, each built on 1 or 2 of the top picks; the
     person's notes win over yours.
   - **The set exists:** use add-variants, with the new variants at the
     top.

   For each ranked reference you use, run
   `node tools/sketch.mjs save-reference --workspace <workspace> --id <reference id> --image <image>`
   and register it on the set's `references`, with `app`, `url`, the
   saved `image`, the person's note (or yours) as `note`, and the
   `variant` it informed. Post a status line as you start, for example
   "Building 3 variants". Report `done` only after publishing, as the
   skill says.

## Building from the sketch

`get_brief`'s `sketch.spec` (also `read_sketch`'s) is what was committed:

- `mode: "skip"`: build from the brief alone, as before.
- `mode: "sketch"`: `direction` (`title`, `point`, `wireframe`, and the
  refine note that produced it), `details` (each with the chosen option's
  `wireframe`), `references` ranked with the person's notes.

The direction's wireframe is the design: its `hl` parts are the change
to build, its notes are requirements, its labels are the copy. Each
chosen detail option is a state of the prototype to build (a preview
state, step 7). The references say what it should feel like; the
product's own components and styles still decide how it looks. Then run
the create-prototype runbook as written, with this briefId.

## Reference retrieval

The earlier local `sketch.mjs candidates`, `mobbin.mjs` and `recent.mjs` search
commands are retired for research. Follow `docs/variant-references.md` and use
`reference-research.mjs`; show its progress and use its ranked selection.
