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
2. Register the loading set with the guarded writer, never by rewriting the
   manifest:
   `node <kit>/tools/variant-manifest.mjs begin <workspace> <component> --title "<short title>"`.
   It saves a backup and adds `status: "building"`, empty `variants`, and empty
   `default`. Creation refuses an existing component ID. Choose a new ID for a
   new set; do not clear or rename an existing set to make room. Keep the
   returned revision for finishing this set. For a dependent set, also pass
   `--requires-component <parent> --requires-variant <parent-variant>` so its
   loading entry has the same dependency as the completed set.
3. Create the directions requested by the brief. Keep each variant in its own
   module with scoped styles under `src/variants/<component>/<variant-id>.*`.
   Shared files may contain only invariant structure, design-system imports,
   and tokens.
4. Ground the directions in real references. Use supplied references first,
   then pull a small, relevant comparison set from Mobbin and register it under
   `references` with images, notes, and variant associations. No Mobbin
   account or Mobbin MCP is needed:
   - Find examples with your web search, restricted to `mobbin.com`
     (e.g. "mobbin create project flow web"). Search for the pattern, not
     the product's domain: a book page's metadata is a product, media or
     listing detail page on Mobbin. Results that are one flow or screen
     (`mobbin.com/explore/flows/<id>`, `.../screens/<id>`) are candidates;
     a topic result (`mobbin.com/explore/web/screens/product-detail`) is
     read with `node <kit>/tools/mobbin.mjs browse web/screens/product-detail`,
     which lists its examples. Without web search, start from
     `node <kit>/tools/mobbin.mjs topics --platform web --match "<words>"`.
   - A title says little about the picture: a flow often opens on a home
     page. `node <kit>/tools/mobbin.mjs screens <url>` says how many screens
     a flow has. Save a candidate with
     `node <kit>/tools/mobbin.mjs save <workspace> <url> --as <name> [--screen <n>]`,
     which writes `public/references/<name>.webp` and prints
     `{app, url, image}`, then look at the picture before using it (if
     your image viewer cannot open WebP, convert a copy outside the
     workspace: `sips -s format png <file> --out <tmp>/<name>.png`). Delete
     the ones you do not use.
   - Keep two to four, at least one per new direction. Add each to the
     set's `references` in the entry you finish in step 5, as
     `{app, url, image, note, variant}`: the note says what to look at
     (for a flow, which screen: its link opens the flow at the start), the
     variant is the id it informs.
   If the tool errors (Mobbin changed its pages), go on without Mobbin
   references and say so in the report.
5. Finish the manifest entry with component, title, variants, `sourceFiles`,
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
