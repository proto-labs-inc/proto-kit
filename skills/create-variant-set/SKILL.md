---
name: create-variant-set
description: Create a new variant set in an existing Proto prototype. Use when the prototype already exists and the user wants to compare multiple new directions for a component. Do not use for adding options to an existing set or editing an existing variant.
---

# Create a variant set

Work only in the existing prototype workspace named by the request. This is
an incremental edit: do not scaffold a prototype, run create-prototype or the
full serve workflow, provision or restart a tunnel, or register the prototype.

## Build the set

1. Read `public/prototype.json`, the selected component, and its current view.
   Preserve every existing state, variant set, marker, and shared style.
2. Immediately add the new set to `prototype.json` with `status: "building"`,
   an empty `variants` array, an empty `default`, and a short title. This lets
   the Frame show progress while the longer design work runs.
3. Create the directions requested by the brief. Keep each variant in its own
   module with scoped styles under `src/variants/<component>/<variant-id>.*`.
   Shared files may contain only invariant structure, design-system imports,
   and tokens.
4. Ground the directions in real references. Use supplied references first;
   otherwise gather a small, relevant comparison set and register it under
   `references` with images, notes, and variant associations.
5. Finish the manifest entry with component, title, variants, `sourceFiles`,
   component-only SVG previews, default, baseline when there is a pre-set
   original, showcase state, and overview. Remove `status` when complete.

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
