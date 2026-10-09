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

1. Read `public/prototype.json`, the selected component, and its current view.
   Preserve every existing state, variant set, marker, and shared style.
2. Register the loading set with the guarded writer, never by rewriting the
   manifest:
   `node <kit>/tools/variant-manifest.mjs begin <workspace> <component> --title "<short title>"`.
   It saves a backup and adds `status: "building"`, empty `variants`, and empty
   `default`. Creation refuses an existing component ID. Choose a new ID for a
   new set; do not clear or rename an existing set to make room. Keep the
   returned revision for finishing this set. For a dependent set, also pass
   `--requires-component <parent> --requires-variant <parent-variant>` so its
   loading entry has the same dependency as the completed set.
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
5. Finish the manifest entry with component, title, variants, `sourceFiles`,
   `references` (with images, notes, source links, and variant associations),
   component-only SVG previews, default, baseline when there is a pre-set
   original, showcase state, and overview. Remove `status` when complete.
   Save that single entry to a temporary JSON file, then run
   `node <kit>/tools/variant-manifest.mjs finish <workspace> <component> --entry <file> --expected <revision>`.
   The entry's component must match the target. If the set changed, read it
   again with the writer's `read` command and reconcile it before retrying.
   Backups live in `<workspace>/.proto/manifest-backups/`, outside the build.
   Store preview, reference-image, and wireframe paths relative to the build
   root without a leading slash, for example `previews/example.svg` and
   `references/example.png`.

## Verify and publish

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
