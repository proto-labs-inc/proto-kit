# References for variants

A copied prototype's variant set can start from references the person
picks in the Frame. All calls go through `node tools/sketch.mjs` (it wraps
the `report_sketch` and `read_sketch` MCP tools). `<id>` below is the
brief id.

**Write every line the person reads in ASD-STE100 Simplified Technical
English**: titles, points, notes, status lines. Short sentences (at most
20 words, a note at most 12), active voice, one idea per sentence, common
words, no idioms or marketing words. "Status sits next to each table." not
"Status is elegantly surfaced in context, so risky tables pop."

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
3. Find references for that component and the brief as
   `docs/variant-references.md` says, keep 6 to 10 that fit, write
   `notes`, and post them as one `references` event. Then post the status
   line "Pick the references you like."
4. Wait with `sketch.mjs wait`, in the foreground (Bash timeout 600000),
   in a loop. Never end your turn while waiting: the person answers in
   the Frame, not in this chat. On
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

## Reference retrieval

The earlier local `sketch.mjs candidates`, `mobbin.mjs` and `recent.mjs` search
commands are retired for research. Follow `docs/variant-references.md` and use
`reference-research.mjs`; show its progress and use its ranked selection.
