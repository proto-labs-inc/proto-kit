#!/usr/bin/env node
/**
 * The skeleton of one variant set, so the main agent decides the set and
 * the variant-builder units write the variants, in parallel, each in its
 * own file. Writes the set into public/prototype.json (status building
 * until previews.mjs has rendered every variant), the switch component
 * that reads useVariant, and one stub module per variant for a unit to
 * replace, and each unit's brief (<build>/briefs/<component>--<id>.md,
 * from variant-brief.mjs). Prints the files and brief each unit owns
 * and the line App.tsx needs.
 *
 * Usage:
 *   node tools/variant-set.mjs <workspace> <component> --title "<set title>"
 *        --variants "<id>=<Title>|<note>;<id>=<Title>|<note>" --default <id>
 *        [--baseline <id>=<Title>] [--state <state id>] [--overview "<what is being decided>"]
 *        [--slot <class>] [--regions <marker>,<marker>,...]
 *
 * --regions: one design decision that changes several parts of the page
 * (the top bar's project switcher and the page's notice) is one set with
 * several regions, never several sets. The first region is the set's key
 * (<component>: the URL's ?v.<component>=, the manifest, the website);
 * every region's switch reads that same choice. Each variant is one module
 * exporting one component per region (PascalCase of its marker) and the
 * variant's shared state (createVariantStore, src/variants/store.ts), so a
 * click in one region can change the other. Each region gets its own
 * switch with its own baseline. Regions must exist as marked elements and
 * may not sit inside each other.
 *
 * --slot names the part's slot class in App.tsx (`className={styles["part42"]}`):
 * replicate pinned the copied part's height on that slot in App.module.css,
 * and a variant of another height needs it freed, so the pin is removed
 * (the copy keeps its height from its own content). A slot with no pin
 * has nothing to free; the set is written the same and `slot.heightFreed`
 * is false.
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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeVariantSet } from "./variant-manifest.mjs";
import { buildOfWorkspace } from "./build-folder.mjs";
import { nestedMarkers, readableMarkup, elementSpan } from "./markup.mjs";
import { variantBrief } from "./variant-brief.mjs";
import { workflowEvent } from "./workflow-report.mjs";
import { createReporter } from "./build-report.mjs";

const USAGE = 'usage: node tools/variant-set.mjs <workspace> <component> --title "<t>" --variants "id=Title|note;..." --default <id> [--baseline id=Title] [--state <id>] [--overview "<sentence>"]';
const options = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--no-send") options.noSend = true;
  else if (args[i].startsWith("--")) {
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

// ---- the regions: marked, and none inside another ----
const regions = options.regions ? options.regions.split(",").map((r) => r.trim()).filter(Boolean) : [component];
if (regions[0] !== component) fail(`the first region is the set's key: --regions ${component},${regions.filter((r) => r !== component).join(",")}`);
for (const r of regions) if (!KEBAB.test(r)) fail(`a region is a data-proto-id, kebab-case: ${r}`);
if (new Set(regions).size !== regions.length) fail("each region once");
const frozenPath = join(workspace, "src", "frozen", "page.html");
const frozen = existsSync(frozenPath);
const pageHtml = frozen ? readFileSync(frozenPath, "utf8") : "";
const markedInSource = (marker) => {
  const src = join(workspace, "src");
  const walk = (d) => readdirSync(d, { withFileTypes: true }).some((e) => (e.isDirectory() ? !["variants", "node_modules"].includes(e.name) && walk(join(d, e.name)) : /\.(tsx|jsx|vue|html)$/.test(e.name) && readFileSync(join(d, e.name), "utf8").includes(`data-proto-id="${marker}"`)));
  return existsSync(src) && walk(src);
};
for (const r of regions) {
  if (frozen ? !elementSpan(pageHtml, r) : !markedInSource(r)) {
    fail(frozen ? `no element marked "${r}" in src/frozen/page.html: add data-proto-id="${r}" to it first` : `no part marked data-proto-id="${r}" under src/`);
  }
}
if (frozen) {
  const nested = nestedMarkers(pageHtml, regions);
  if (nested.length) fail(`regions may not sit inside each other: "${nested[0][1]}" is inside "${nested[0][0]}" (replacing the outer one removes the inner one)`);
}
// Refuse duplicate creation before touching the switch, styles, or slot.
const entry = {
  component, title: options.title, status: "building",
  variants: [
    ...variants.map(v => ({ ...v, sourceFiles: [`src/variants/${component}/${v.id}.tsx`, `src/variants/${component}/${v.id}.module.css`] })),
    ...(baseline ? [baseline] : []),
  ],
  default: options.default,
  regions,
};
if (options.state) entry.state = options.state;
if (baseline) entry.baseline = baseline.id;
if (options.overview) entry.overview = { title: options.title, description: options.overview };
try {
  if (existsSync(join(workspace, "src", "variants", component, "index.tsx"))) fail(`${component} already has a switch; creation cannot overwrite it`);
  writeVariantSet(workspace, { operation: "create", component, entry });
} catch (error) { fail(error.message); }

const multi = regions.length > 1;
const regionNames = regions.map((r) => ({ marker: r, Name: pascal(r), Switch: `${pascal(r)}Variants` }));
mkdirSync(dir, { recursive: true });
const rel = (file) => `src/variants/${component}/${file}`;

// ---- one stub per variant: the unit's file, complete enough to render ----
const written = [];
for (const variant of variants) {
  const Name = pascal(variant.id);
  const module = join(dir, `${variant.id}.tsx`);
  const styles = join(dir, `${variant.id}.module.css`);
  if (!existsSync(module) && multi) {
    writeFileSync(
      module,
      `import { createVariantStore } from "../store";
import styles from "./${variant.id}.module.css";

/**
 * ${variant.title}: ${variant.note || "one direction for this decision"}.
 * One component per region of the "${options.title}" set; each root keeps its
 * region's data-proto-id. Written by a variant-builder unit.
 */

/** What this variant's regions share while it is shown (a menu open, a
 *  choice made); anything a reviewer should link to is a preview state. */
export const useShared = createVariantStore({});

${regionNames
  .map(
    (r) => `export function ${r.Name}({ className }: { className?: string }) {
  return (
    <div className={[styles.root, className].filter(Boolean).join(" ")} data-proto-id="${r.marker}">
      {"${variant.title} (${r.marker}): not written yet"}
    </div>
  );
}`,
  )
  .join("\n\n")}
`,
    );
  }
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

// ---- menus: placed under their trigger ----
// A menu inside a top bar is clipped by it, so builders portal it into
// <body>, where it lost its place and opened at the page's left edge (the
// main agent fixed it by hand in R2 before and after). One hook places it.
const anchorFile = join(workspace, "src", "variants", "anchor.ts");
if (!existsSync(anchorFile)) {
  writeFileSync(
    anchorFile,
    `import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

/**
 * Where a menu or popover opened from \`trigger\` sits when it is rendered
 * through createPortal into document.body (so the region it opens from,
 * say a top bar, does not clip it): fixed, just under the trigger, aligned
 * to its start or end edge, following it as the page lays out, scrolls
 * and resizes.
 *
 *   const style = useAnchor(buttonRef, { open, align: "start" });
 *   {open && createPortal(<div style={style} data-proto-id="<region>-menu">…</div>, document.body)}
 */
export function useAnchor(
  trigger: RefObject<HTMLElement | null>,
  { open = true, align = "start", gap = 4 }: { open?: boolean; align?: "start" | "end"; gap?: number } = {},
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) return;
    // Every frame while open: the frozen page's stylesheets and fonts land
    // after a menu opened in a preview state, and move the trigger without
    // resizing anything (R2-again's menus opened 150 px off).
    let frame = 0;
    let last = "";
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (r) {
        const next: CSSProperties =
          align === "end"
            ? { position: "fixed", top: r.bottom + gap, right: window.innerWidth - r.right, zIndex: 50 }
            : { position: "fixed", top: r.bottom + gap, left: r.left, zIndex: 50 };
        const key = JSON.stringify(next);
        if (key !== last) {
          last = key;
          setStyle(next);
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [trigger, open, align, gap]);
  return style;
}
`,
  );
}

// ---- the switch ----
const SwitchName = `${pascal(component)}Variants`;
const ids = [...(baseline ? [baseline.id] : []), ...variants.map((v) => v.id)];
const cases = written.map((v) => `    case "${v.id}":\n      return <${v.Name} className={className} />;`).join("\n");
const IDS = `${SwitchName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_IDS`;
if (multi) {
  // The variants' shared state: one module both regions import, so it is
  // shared across the portals Frozen renders each region through.
  const store = join(workspace, "src", "variants", "store.ts");
  if (!existsSync(store)) {
    writeFileSync(
      store,
      `import { useSyncExternalStore } from "react";

/**
 * State a variant's regions share (src/variants/<set>/<id>.tsx exports
 * \`useShared = createVariantStore({ ... })\`): every region calls
 * \`const [shared, setShared] = useShared()\` and sees the same values, even
 * though each region renders in its own place on the page.
 */
export function createVariantStore<T extends object>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const set = (next: Partial<T> | ((current: T) => Partial<T>)) => {
    value = { ...value, ...(typeof next === "function" ? next(value) : next) };
    for (const listener of listeners) listener();
  };
  return function useShared(): [T, typeof set] {
    return [useSyncExternalStore(subscribe, () => value, () => value), set];
  };
}
`,
    );
  }
  const modules = written.map((v) => ({ ...v, NS: `${v.Name}Variant` }));
  writeFileSync(
    join(dir, "index.tsx"),
    `import type { ReactNode } from "react";
import { useVariant } from "@proto-labs-inc/rig";
${modules.map((v) => `import * as ${v.NS} from "./${v.id}";`).join("\n")}

export const ${IDS} = ${JSON.stringify(ids)} as const;

/**
 * ${options.title}: one decision across ${regions.length} regions (${regions.join(", ")}),
 * chosen by ?v.${component}=<id>. Every region's switch reads that one
 * choice; \`baseline\` is the region as the page has it today.
 */
${regionNames
  .map(
    (r) => `export function ${r.Switch}({ className, baseline }: { className?: string; baseline: ReactNode }) {
  const [variant] = useVariant("${component}", "${options.default}", ${IDS});
  switch (variant) {
${modules.map((v) => `    case "${v.id}":\n      return <${v.NS}.${r.Name} className={className} />;`).join("\n")}
    default:
      return <>{baseline}</>;
  }
}`,
  )
  .join("\n\n")}

export default ${regionNames[0].Switch};
`,
  );
} else writeFileSync(
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
// A slot replicate did not pin (the part came out at its own height)
// has nothing to free: the set is written all the same, and `slot`
// says so. Stopping here left the manifest unwritten and the set half
// made for a part that happened to fit.
let slot = null;
if (options.slot) {
  const cssPath = join(workspace, "src", "App.module.css");
  const css = readFileSync(cssPath, "utf8");
  const block = new RegExp(`(\\.page \\.${options.slot} \\{[^}]*?)\\n  height: [^;]+;`, "m");
  if (block.test(css)) {
    writeFileSync(cssPath, css.replace(block, "$1"));
    slot = { class: options.slot, heightFreed: true };
  } else {
    slot = { class: options.slot, heightFreed: false, note: `no pinned height on .page .${options.slot} in src/App.module.css; nothing to free` };
  }
}

// Each builder's brief (tools/variant-brief.mjs), in the build folder:
// the main agent dispatches with the file and what that variant is.
const build = buildOfWorkspace(workspace);
const briefsDir = join(build ? build.dir : join(workspace, ".proto-checks"), "briefs");
mkdirSync(briefsDir, { recursive: true });
// Each region's frozen markup laid out a tag per line: page.html is one
// line, so a builder's grep came back as the whole page, twice.
const markup = {};
if (frozen) {
  mkdirSync(join(briefsDir, "markup"), { recursive: true });
  for (const r of regions) {
    const span = elementSpan(pageHtml, r);
    markup[r] = join(briefsDir, "markup", `${r}.html`);
    writeFileSync(markup[r], readableMarkup(pageHtml.slice(span.start, span.end)));
  }
}
for (const v of written) {
  v.brief = join(briefsDir, `${component}--${v.id}.md`);
  writeFileSync(v.brief, variantBrief({ workspace, component, setTitle: options.title, variant: v, regions: regionNames.map((r) => ({ ...r, markup: markup[r.marker] ?? null })) }));
}

// The site hears the set is being written from the tool itself, so it never sits on the copy's last line.
if (build) {
  const reporter = createReporter({ codebase: build.codebase, briefId: build.briefId, runDir: build.dir, sink: options.noSend ? "file" : "site" });
  reporter.send([workflowEvent(build.dir, "build", `Writing the "${options.title}" variant set (${variants.length} variant${variants.length === 1 ? "" : "s"})`)]);
  await reporter.flush();
}
console.log(
  JSON.stringify({
    component,
    switch: multi
      ? {
          module: rel("index.tsx"),
          regions: regionNames.map((r) => ({ marker: r.marker, Name: r.Switch })),
          import: `import { ${regionNames.map((r) => r.Switch).join(", ")} } from "./variants/${component}";`,
          usage: frozen
            ? `<Frozen replace={{ ${regionNames.map((r) => `"${r.marker}": <${r.Switch} baseline={<FrozenHtml marker="${r.marker}" />} />`).join(", ")} }} />`
            : regionNames.map((r) => `<${r.Switch} className={...} baseline={<ThePart className={...} />} />  (in place of the part marked ${r.marker})`).join("\n"),
        }
      : { module: rel("index.tsx"), Name: SwitchName, usage: `<${SwitchName} className={...} baseline={<ThePart className={...} />} />` },
    regions,
    variants: written,
    baseline,
    slot,
    manifest: "public/prototype.json",
  }),
);
