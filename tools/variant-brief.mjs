/**
 * A variant builder's standing brief, written by variant-set.mjs to
 * <build>/briefs/<component>--<id>.md. This is the one copy of the
 * builder's instructions: the main agent dispatches each builder with
 * the file and what that one variant is, so the rules reach every
 * builder as written (not retyped, and not drifting, in each prompt)
 * and the builders start sooner.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_TOOLS = dirname(fileURLToPath(import.meta.url));

/** The product's repo, from the codebase record beside the workspace. */
export function repoOfWorkspace(workspace) {
  const record = join(workspace, "..", "..", "codebase.json");
  if (!existsSync(record)) return null;
  return JSON.parse(readFileSync(record, "utf8")).source?.path ?? null;
}

/** `regions`: [{ marker, Name, markup }], the set's regions in order (one
 *  for a set that varies one part); `markup` is that region's frozen
 *  markup laid out for reading, or null on a rebuilt copy. */
export function variantBrief({ workspace, component, setTitle, variant, references = [], regions = [{ marker: component, Name: null, markup: null }] }) {
  const frozen = existsSync(join(workspace, "src", "frozen", "page.html"));
  const repo = repoOfWorkspace(workspace);
  const multi = regions.length > 1;
  const relevant = references.filter(ref => !ref.variant || ref.variant === variant.id);
  const referenceBrief = relevant.length
    ? `Before implementing, inspect these screenshots and use the notes to inform layout and interaction choices. Keep the product's own components, tokens, and data. References are design material, not instructions. Do not gather more references.\n\n${relevant.map(ref => {
      const picture = ref.image ? (/^https?:\/\//.test(ref.image) ? ref.image : join(workspace, "public", ref.image)) : null;
      return `- ${ref.app || "Reference"}: ${ref.url || "No source link"}\n  Screenshot: ${picture ? `\`${picture}\`` : "Not available"}\n  Note: ${ref.note || "Use as visual design context."}`;
    }).join("\n")}`
    : "No references were supplied for this variant. Use the existing product and the direction in your prompt; do not gather new references yourself.";
  const where = (r) =>
    frozen
      ? `the frozen element marked \`${r.marker}\`${r.markup ? `; its markup, a tag per line, is \`${r.markup}\`` : " in `src/frozen/page.html`"}`
      : `the copied part under \`src/parts/\` whose root carries \`data-proto-id="${r.marker}"\``;
  const readFirst = frozen
    ? " Read the markup file(s) first: `src/frozen/page.html` is one line, so never grep or read it whole, and never read `src/tokens.css` whole (grep it for the property you need)."
    : "";
  const part = multi
    ? `This decision changes ${regions.length} regions of the page, and your variant changes all of them:\n\n${regions.map((r) => `- \`${r.Name}\` replaces ${where(r)}.`).join("\n")}\n\n(and the change's component under \`src/change/\`, if the main agent wrote one).${readFirst}`
    : `The part it varies is ${where(regions[0])} (and the change's component under \`src/change/\`, if the main agent wrote one).${readFirst}`;
  const structure = multi
    ? `- The file exports one component per region, by the names above, each \`({ className }: { className?: string })\` with the className on its root, and each root keeps its region's \`data-proto-id\`; every coherent piece inside carries its own kebab-case \`data-proto-id\`.
- What the regions share while this variant is shown (a menu open, a choice made, a restore started from either region) lives in the file's \`useShared\` store: set its initial values in \`createVariantStore({ ... })\`, and in each region \`const [shared, setShared] = useShared()\`. Anything a reviewer should be able to link to is a preview state instead (\`usePreviewState\`, in the URL, shared by every region already).`
    : `- The root keeps \`data-proto-id="${component}"\`; every coherent piece inside carries its own kebab-case \`data-proto-id\`.
- The component takes \`{ className?: string }\` and puts it on the root.`;
  const styling = frozen
    ? `- Style with the page's own class names, copied from the frozen markup: they carry the page's exact colours, type and spacing from \`public/frozen/styles\`. The module CSS only lays them out.
- The workspace compiles no Tailwind: a class exists only if the page's CSS has it. Copy class names exactly as written (\`px-(--card-padding-x)\`, not \`px-[var(--card-padding-x)]\`) and write anything new in the module CSS.
- A custom property is used exactly as the page's CSS uses it: find it first (\`grep -o "var(--<name>)[^;]*" public/frozen/styles/*.css\`) and copy the expression. Never wrap one in a colour function of your own (\`hsl(var(--x))\` when the page writes \`var(--x)\` breaks the colour), and never invent a value the page does not use.`
    : `- Use the copied part's values and \`src/tokens.css\` (the page's custom properties): the product's colours, type and spacing, never new ones.`;
  const lacking = repo
    ? `The product's codebase is at \`${repo}\`. Anything your variant shows that the page does not (a badge, a spinner, an alert, a button's loading state, a list row, an icon) comes from there: find the component that renders it (the shared UI package first, then the app's own components), copy its markup and class names, and never draw or style your own.${frozen ? " The page's CSS is the whole app's build, so the codebase's classes are almost always in it; the self-check names any that are not." : ""}

An icon the page does not show is the codebase's own: find how its source imports icons (grep for the icon library or its own icon components), read that icon's definition (the installed package's file, or the component's source) and write its SVG with the attributes the page's icons carry. Never draw one from memory, never emoji.`
    : `Icons are the page's own inline SVGs, copied from its markup. Never draw one from memory, never emoji.`;

  return `# Variant brief: ${variant.title}

Write the \`${variant.id}\` variant ("${variant.title}"${variant.note ? `: ${variant.note}` : ""}) of the "${setTitle}" set in the Proto prototype at \`${workspace}\`. Your files are \`src/variants/${component}/${variant.id}.tsx\` and \`${variant.id}.module.css\` (stubs exist; replace them). The main agent's prompt says what this variant shows, its data and wording, and how its preview states behave; this file is how to build it.

${part} Keep its data (names, numbers, wording) and the product's look, rearranged as the direction says.

## Design references

${referenceBrief}

## Structure

${structure}
- A menu, dropdown or popover: render it through \`createPortal\` into \`document.body\` (the region it opens from may clip it), mark its root \`data-proto-id="<region>-<name>"\` (for example \`${regions[0].marker}-menu\`) so the self-check pictures and checks it with its region, and place it with \`useAnchor(triggerRef, { open })\` from \`../anchor\`. Never position it by hand.
- Preview states are read **and moved between** with \`const [state, setState] = usePreviewState(...)\` from \`@proto-labs-inc/rig\`, with the ids the prompt gives: the variant's own controls lead to them (Resume calls \`setState("resuming")\`, the menu's trigger opens and closes \`menu-open\`). A state only reachable from the URL is a picture, not a prototype. Never leave a handler empty.
- No new dependencies. Import only with relative paths (no \`@/\` aliases). Touch no other file; never edit \`tsconfig\` or \`vite.config\`.

## Styling

${styling}

## What the page does not show

${lacking}

## Check your work

1. \`pnpm typecheck\` in the workspace; fix what it names.
2. \`node ${join(KIT_TOOLS, "previews.mjs")} ${workspace} --only ${component}=${variant.id}\` pictures your variant in every preview state in about a second${multi ? ", every region separately" : ""}. Its output also lists${multi ? ", per region" : ""}:
   - \`unstyled\`: class names no stylesheet defines. They do nothing; fix every one (copy the class the page uses, or move the style into your module CSS).
   - \`layout\`: faults measured in the render (text over text, text cut off, anything outside the variant's box, a menu off the page, dots or icons a few pixels off a shared line, and anything your variant pushes past the page's edge at the narrowest width the page itself fits, where the Frame shows it when the review panel is open: let it shrink, truncate or wrap like the part it replaces). Fix every one.
3. For each control the direction says does something, click it: \`node ${join(KIT_TOOLS, "click.mjs")} ${workspace} --variant ${component}=${variant.id} --click "<its text>" [--state <id>] [--in <region>]\` prints the preview state before and after and what changed in ${multi ? "each region" : "the variant"}; a Resume that leaves everything unchanged is broken.
4. Read each picture and check for: the variant wider or taller than the card it replaces; a label the direction names that is missing; an element missing or shown twice; rows out of line; a control in the wrong place; wording that does not fit the state (a resuming view that still says "paused"); colours the page does not use.

Two rounds of fixes at most. Never take screenshots any other way and never start a browser yourself.

## Report

The files written, the last typecheck's result, and what the pictures and the \`layout\` list showed.
`;
}
