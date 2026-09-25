---
name: edit-variant
description: Edit one existing variant in a Proto prototype. Use when the prototype, variant set, and target variant already exist and the user wants that single variant changed. Do not use to create a set or add a new variant.
---

# Edit a variant

Work only in the existing prototype workspace, variant set, and variant named
by the request. This is an incremental edit: do not scaffold a prototype, run
create-prototype or the full serve workflow, gather references, provision or
restart a tunnel, or register the prototype.

## Make the edit

1. Read `public/prototype.json`, the target view, and the variant's recorded
   `sourceFiles` before searching more broadly.
2. Change only the target variant's module and scoped styles. Preserve its ID,
   every sibling variant, preview state, component marker, URL behavior, and
   shared design-system token unless the brief explicitly requires a related
   metadata change.
3. If the target still lives in a shared file, extract only the touched
   variant. Do not rewrite unaffected variants.
4. When appearance changes, update the target variant's component-only SVG
   preview and keep its `sourceFiles` accurate. Do not change references unless
   the user asks.

## Verify and publish

- Run `pnpm typecheck`. Verify the target view and one unaffected sibling
  through the already-running Vite server; let HMR carry source changes.
- Check the affected set's SVG previews together. They must be current,
  component-only, consistently framed and padded, and rendered on the page
  background.
- Run `pnpm build` from the prototype workspace.
- Publish exactly once with
  `node <kit>/tools/publish.mjs --kind prototype <workspace>`, resolving
  `<kit>` from the installed Proto plugin root.
- Report completion only after that publish succeeds.
