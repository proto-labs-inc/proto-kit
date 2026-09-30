#!/usr/bin/env node
/**
 * The skeleton of one variant set, so the main agent decides the set and
 * the variant-builder units write the variants, in parallel, each in its
 * own file. Writes the set into public/prototype.json (status building
 * until previews.mjs has rendered every variant), the switch component
 * that reads useVariant, and one stub module per variant for a unit to
 * replace. Prints the files each unit owns and the line App.tsx needs.
 *
 * Usage:
 *   node tools/variant-set.mjs <workspace> <component> --title "<set title>"
 *        --variants "<id>=<Title>|<note>;<id>=<Title>|<note>" --default <id>
 *        [--baseline <id>=<Title>] [--state <state id>] [--overview "<what is being decided>"]
 *        [--slot <class>]
 *
 * --slot names the part's slot class in App.tsx (`className={styles["part42"]}`):
 * replicate pinned the copied part's height on that slot in App.module.css,
 * and a variant of another height needs it freed, so the pin is removed
 * (the copy keeps its height from its own content).
 *
 * <component> is the data-proto-id of the part the set varies: every
 * variant's root carries it, so the Frame's picker, the set and the
 * copy's part are one thing. The baseline is the copy as it is today:
 * it has no file, the switch renders what App.tsx passes as `baseline`.
 *
 * App.tsx then renders the switch in the part's place, with the part
 * itself as the baseline:
 *   <UsageSummaryVariants className={styles["part33"]} baseline={<UsageSummary className={styles["part33"]} />} />
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE = 'usage: node tools/variant-set.mjs <workspace> <component> --title "<t>" --variants "id=Title|note;..." --default <id> [--baseline id=Title] [--state <id>] [--overview "<sentence>"]';
const options = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [workspace, component] = positional;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!workspace || !component || !options.title || !options.variants || !options.default) fail(USAGE);
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
if (!KEBAB.test(component)) fail(`the component is a data-proto-id, kebab-case: ${component}`);

const variants = options.variants.split(";").map((spec) => {
  const [id, rest = ""] = spec.split("=");
  const [title, note = ""] = rest.split("|");
  if (!KEBAB.test(id.trim()) || !title?.trim()) fail(`each variant is id=Title|note: "${spec}"`);
  return { id: id.trim(), title: title.trim(), note: note.trim() };
});
let baseline = null;
if (options.baseline) {
  const [id, title = "Current"] = options.baseline.split("=");
  if (!KEBAB.test(id)) fail(`the baseline is id=Title: "${options.baseline}"`);
  baseline = { id, title: title.trim(), note: "The page as it is today" };
}
if (!variants.some((v) => v.id === options.default) && baseline?.id !== options.default) fail(`--default ${options.default} is not one of the variants`);

const pascal = (slug) => slug.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const dir = join(workspace, "src", "variants", component);
mkdirSync(dir, { recursive: true });
const rel = (file) => `src/variants/${component}/${file}`;

// ---- one stub per variant: the unit's file, complete enough to render ----
const written = [];
for (const variant of variants) {
  const Name = pascal(variant.id);
  const module = join(dir, `${variant.id}.tsx`);
  const styles = join(dir, `${variant.id}.module.css`);
  if (!existsSync(module)) {
    writeFileSync(
      module,
      `import styles from "./${variant.id}.module.css";

/**
 * ${variant.title}: ${variant.note || "one direction for this part"}.
 * Written by a variant-builder unit; the root keeps data-proto-id="${component}"
 * so the Frame's picker and comments find this part in every variant.
 */
export default function ${Name}({ className }: { className?: string }) {
  return (
    <div className={[styles.root, className].filter(Boolean).join(" ")} data-proto-id="${component}">
      {"${variant.title}: not written yet"}
    </div>
  );
}
`,
    );
  }
  if (!existsSync(styles)) writeFileSync(styles, `/* ${variant.title}: the part's own values, from src/tokens.css and the copied part. */\n.root {\n}\n`);
  written.push({ id: variant.id, title: variant.title, note: variant.note, module: rel(`${variant.id}.tsx`), styles: rel(`${variant.id}.module.css`), Name });
}

// ---- the switch ----
const SwitchName = `${pascal(component)}Variants`;
const ids = [...(baseline ? [baseline.id] : []), ...variants.map((v) => v.id)];
const cases = written.map((v) => `    case "${v.id}":\n      return <${v.Name} className={className} />;`).join("\n");
writeFileSync(
  join(dir, "index.tsx"),
  `import type { ReactNode } from "react";
import { useVariant } from "@proto-labs-inc/rig";
${written.map((v) => `import ${v.Name} from "./${v.id}";`).join("\n")}

export const ${SwitchName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_IDS = ${JSON.stringify(ids)} as const;

/**
 * ${options.title}: the "${component}" part in each direction the set
 * compares, chosen by ?v.${component}=<id>. \`baseline\` is the copied
 * part as the page has it today.
 */
export default function ${SwitchName}({ className, baseline }: { className?: string; baseline: ReactNode }) {
  const [variant] = useVariant("${component}", "${options.default}", ${SwitchName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_IDS);
  switch (variant) {
${cases}
    default:
      return <>{baseline}</>;
  }
}
`,
);

// ---- the slot: no pinned height for a part that will change size ----
let slot = null;
if (options.slot) {
  const cssPath = join(workspace, "src", "App.module.css");
  const css = readFileSync(cssPath, "utf8");
  const block = new RegExp(`(\\.page \\.${options.slot} \\{[^}]*?)\\n  height: [^;]+;`, "m");
  if (!block.test(css)) fail(`no pinned height on .page .${options.slot} in src/App.module.css`);
  writeFileSync(cssPath, css.replace(block, "$1"));
  slot = { class: options.slot, heightFreed: true };
}

// ---- the manifest ----
const manifestPath = join(workspace, "public", "prototype.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entry = {
  component,
  title: options.title,
  status: "building",
  variants: [
    ...written.map((v) => ({ id: v.id, title: v.title, note: v.note, sourceFiles: [v.module, v.styles] })),
    ...(baseline ? [{ id: baseline.id, title: baseline.title, note: baseline.note }] : []),
  ],
  default: options.default,
};
if (options.state) entry.state = options.state;
if (baseline) entry.baseline = baseline.id;
if (options.overview) entry.overview = { title: options.title, description: options.overview };
manifest.variantSets = [...(manifest.variantSets ?? []).filter((set) => set.component !== component), entry];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log(
  JSON.stringify({
    component,
    switch: { module: rel("index.tsx"), Name: SwitchName, usage: `<${SwitchName} className={...} baseline={<ThePart className={...} />} />` },
    variants: written,
    baseline,
    slot,
    manifest: "public/prototype.json",
  }),
);
