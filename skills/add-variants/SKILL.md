---
name: add-variants
description: Add one or more new variants to an existing variant set in a Proto prototype. Use when both the prototype and target variant set already exist. Do not use to create a set or modify an existing variant.
---

# Add variants

Work only in the existing prototype workspace and variant set named by the
request. This is an incremental edit: do not scaffold a prototype, run
create-prototype or the full serve workflow, provision or restart a tunnel,
register the prototype, or change unrelated states or variant sets.

## Add the variants

1. Read `public/prototype.json`, the target set, the current view, and the
   source files recorded for the selected reference variants.
2. Preserve all existing variants and their relative order. Put the new
   variants at the top of the set's `variants` array.
3. Reuse the selected variants and registered references as design context.
   Do not gather new external references unless the brief explicitly asks for
   research.
4. Put each new variant in its own module with scoped styles under
   `src/variants/<component>/<variant-id>.*`. Shared files may contain only
   genuinely invariant structure or tokens.
5. Register only the new variants and any requested set-level metadata change.
   Each variant needs accurate `sourceFiles` and a component-only SVG preview.
   Store preview, reference-image, and wireframe paths relative to the build
   root without a leading slash, for example `previews/example.svg`.

## Verify and publish

- Run `pnpm typecheck`. Verify every new variant and one unaffected sibling
  through the already-running Vite server; let HMR carry source changes.
- Check the affected set's SVG previews together. They must be current,
  component-only, consistently framed and padded, and rendered on the page
  background.
- Run `pnpm build` from the prototype workspace.
- Publish exactly once with
  `node <kit>/tools/publish.mjs --kind prototype <workspace>`, resolving
  `<kit>` from the installed Proto plugin root.
- Report completion only after that publish succeeds.
