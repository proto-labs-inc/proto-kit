---
name: create-variant-set
description: Create a new variant set in an existing Proto prototype. Use when the prototype already exists and the user wants to compare multiple new directions for a component. Do not use for adding options to an existing set or editing an existing variant.
---

# Create a variant set

A website brief (action `add-variants`, the element in `section`) is read
with `get_brief`; when its `inputs.references` is true, follow "References
for variants" in `docs/sketch.md`: the person picks the references first,
and those replace step 3's own search. Report `started` when work begins
and `done` only after publishing.

Work only in the existing prototype workspace named by the request. This is
an incremental edit: do not scaffold a prototype, run create-prototype or the
full serve workflow, provision or restart a tunnel, or register the prototype.

## Build the set

1. Immediately after the required kit version check, read only
   `public/prototype.json`. A request for a new set always creates a new set,
   even when another set has the same title or selected element. Only use
   add-variants when the user explicitly requests more variants in an existing
   set and identifies that set. Do not inspect source, browse the prototype,
   or search for references before registering new work.
2. Register the loading set with the guarded writer, never by rewriting the
   manifest:
   `node <kit>/tools/variant-manifest.mjs begin <workspace> <selected-element> --title "<short title>"`.
   It saves a backup and appends a new entry with a fresh UUID `id`, a unique
   `component` address (`set-<uuid>`), `regions: ["<selected-element>"]`,
   `status: "building"`, empty `variants`, and empty `default`.
   Title the set for its subject or design decision, regardless of whether
   references come first. Do not add "references" as a workflow label; use
   that word only when it describes the actual subject matter. For example,
   use "Policy list", not "Policy list references".
   Keep its returned entry and revision. Names and selected elements are not
   set identities. Never remove, rename, or reuse another set or its identity.
   For a dependent set, also pass `--requires-component <parent-component>`
   and `--requires-variant <parent-variant>`.
   Use the returned `component` for every set address: manifest edits,
   `src/variants/<component>/`, `useVariant`, URL choices, and preview commands.
   Preserve the original DOM markers in `regions` and on variant roots.
   To scaffold this entry later, pass its returned component and revision to
   `node <kit>/tools/variant-set.mjs <workspace> <component> --expected <revision> ...`.
   The scaffolder updates that same empty building entry and returns a new
   revision; it never creates another set. Keep that revision for finishing.
   Now read the selected component and current view. Preserve existing states,
   variants, markers, dependencies, and shared styles.
3. Before choosing or building directions, gather and inspect references using
   `docs/variant-references.md`. Use supplied references first and Mobbin's
   no-account web path, never the Mobbin MCP. This applies to every new set.
4. Design the requested directions using those references. Keep each variant in
   its own module with scoped styles under
   `src/variants/<component>/<variant-id>.*`. Shared files may contain only
   invariant structure, design-system imports, and tokens. If delegating, give
   each builder its relevant local screenshots, source links, and notes before
   it starts. Inspect the screenshots before implementing, and preserve the
   product's own components and tokens.
5. Finish the same manifest entry with its assigned id and component, regions, title, variants, `sourceFiles`,
   `references` (with images, notes, source links, and variant associations),
   component-only SVG previews, default, baseline when there is a pre-set
   original, showcase state, and overview. Remove `status` when complete.
   Save that single entry to a temporary JSON file, then run
   `node <kit>/tools/variant-manifest.mjs finish <workspace> <component> --entry <file> --expected <revision>`.
   The entry's component must match the writer-assigned component. If the set changed, read it
   again with the writer's `read` command and reconcile it before retrying.
   Backups live in `<workspace>/.proto/manifest-backups/`, outside the build.
   Store preview, reference-image, and wireframe paths relative to the build
   root without a leading slash, for example `previews/example.svg` and
   `references/example.png`.

## References-only first pass

When the copied prompt requests references only, gather 10 distinct, relevant
visual references and inspect every screenshot. Save app, url, image, and note
for each reference in this same set. Leave variants empty and default as an
empty string, omit baseline, and use the guarded writer to finish the set with
no status. Do not scaffold variants or start a separate selection workflow.
Verify that every image is served by the running prototype and renders in its
References gallery, then stop. A references-only pass does not require a build
or publish; skip the Verify and publish section below. The normal Add more
variants composer requests the first variants later in this same set.

## Verify and publish

This section applies to passes that create variants.

- Run `pnpm typecheck`. Verify the requested view and one unaffected existing
  view through the already-running Vite server; let HMR carry source changes.
- Check the affected set's SVG previews together. They must be current,
  component-only, consistently framed and padded, and rendered on the page
  background.
- Run `pnpm build` from the prototype workspace.
- Publish exactly once with
  `node <kit>/tools/publish.mjs --kind prototype <workspace>`, resolving
  `<kit>` from the installed Proto plugin root.
- Report completion only after that publish succeeds.
