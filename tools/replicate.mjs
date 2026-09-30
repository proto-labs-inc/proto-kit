#!/usr/bin/env node
/**
 * An exact copy of the reference page in the prototype workspace, in
 * one call, from the build's read: every leaf of the curation becomes a
 * part (a library component when one matches, else written from the
 * captured page by tools/snapshot.mjs), each is checked against the
 * live page (tools/check.mjs), the sections and packaging are composed
 * into src/App.tsx with their layout from the captured styles, and the
 * page is fitted and checked as a whole. Several lanes at once,
 * heaviest first. Each pass and match streams to the site as it lands.
 * Parts the page needed and the library lacked are copied into the
 * library, so the next build reuses them.
 *
 * Usage: node tools/replicate.mjs <briefId> --codebase <id> [--lanes 12] [--no-send] [--keep-dev] [--port 9333]
 *
 * Needs, in ~/.proto/<codebase>/run/builds/<briefId>/: tree.json and
 * read.json (build-stream.mjs read), curation.json (curate, reviewed,
 * and named), workspace.json (scaffold.mjs). Starts the workspace's dev
 * server when it is not up, and stops it again unless --keep-dev.
 *
 * Prints one JSON line: { seconds, parts: [{ id, slug, marker, reused,
 * status }], matched: [id], toFix: [{ id, slug, states, reason, rule }],
 * failed: [{ id, slug, error }], reused: [id], page: { verdict, mismatch,
 * pct }, learned, fitted, timings, gate: { proceed, line } }, where a
 * part's status is matched, differs or failed.
 *
 * The composed page is the copy's gate (tools/tail.mjs rule 1): the
 * build goes on to the change from here, whatever is left, and every
 * part left is the long tail with its reason (a small share of the
 * page, or simply not matched at the gate) for a background unit.
 * `gate.proceed` is false only when the copy is unusable: the page did
 * not mount, or its difference is beyond TAIL.PAGE_PROCEED_PCT.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReporter } from "./build-report.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { findPage } from "./cdp/attach.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { diffPngs, THRESHOLD } from "./cdp/diff.mjs";
import { displayOf, headlessPage } from "./cdp/headless.mjs";
import { framePaths } from "./cdp/live.mjs";
import { ACCEPTED, checkComponent, liveMatchOf } from "./check.mjs";
import { TAIL, classifyPart, record, tailFile } from "./tail.mjs";
import { instanceFromRead, styleOf } from "./read-page.mjs";
import { appBaseline, cssBlock, instanceOf, jsxAttr, kindOf, layoutOf, nameNodes, pascal, propsFor, pseudoProps, shapeFingerprint, writeComponent } from "./snapshot.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const started = Date.now();
// A tab closed under a pending call rejects after its lane moved on; that is that lane's failure, not the build's.
process.on("unhandledRejection", (reason) => console.error(`… a late failure: ${reason?.message ?? reason}`));
const timings = {};
const stage = (name, began) => {
  timings[name] = Math.round((Date.now() - began) / 100) / 10;
};
const step = (message) => console.error(`… ${message}`);

const options = { lanes: "12", port: "9333" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--no-send") options.noSend = true;
  else if (args[i] === "--keep-dev") options.keepDev = true;
  else if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [briefId] = positional;
const codebase = options.codebase;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!briefId || !codebase) fail("usage: node tools/replicate.mjs <briefId> --codebase <id> [--lanes 12] [--no-send] [--keep-dev]");

const homeDir = process.env.HOME ?? "";
const home = join(homeDir, ".proto", codebase);
const buildDir = join(home, "run", "builds", briefId);
const need = (name, hint) => {
  const path = join(buildDir, name);
  if (!existsSync(path)) fail(`${path} does not exist: ${hint}`);
  return JSON.parse(readFileSync(path, "utf8"));
};
const tree = need("tree.json", "run build-stream.mjs read first");
const read = need("read.json", "run build-stream.mjs read first");
const curation = tree.curation ?? need("curation.json", "run build-stream.mjs curate, review it, then name");
const workspace = need("workspace.json", "run scaffold.mjs first");
const library = join(home, "library");
const appUrl = `http://localhost:${workspace.port}`;
const liveMatch = liveMatchOf(tree.url);
const checksDir = join(buildDir, "checks");
const partsDir = join(workspace.path, "src", "parts");
const reporter = createReporter({ codebase, briefId, runDir: buildDir, sink: options.noSend ? "file" : "site" });

const nodesById = new Map(tree.nodes.map((node) => [node.id, node]));
const roleOf = new Map(curation.map((entry) => [entry.id, entry]));
const leaves = curation.filter((entry) => entry.role === "leaf").map((entry) => ({ entry, node: nodesById.get(entry.id) }));
if (leaves.length === 0) fail("the curation names no leaves: nothing to replicate");

// ---- the dev server ----
const began = Date.now();
const dev = await ensureDevServer({ workspace: workspace.path, logPath: join(buildDir, "dev.log"), keep: Boolean(options.keepDev) });
const stopDev = () => dev.stop();

// The display the live page is drawn on: what the headless Chrome must match.
const tab = await findPage(liveMatch, Number(options.port));
if (!tab) fail(`the reference page (${liveMatch}) is not open in the Proto window`);
const live = await connect(tab.webSocketDebuggerUrl);
const display = await displayOf(live);
live.close();
const viewport = { width: tree.viewport.width, height: tree.viewport.height };
// Vite's first requests find dependencies to pre-bundle and reload the
// page once they are; a lane's render caught mid-reload fails with
// "target navigated". The page is opened until a load goes through
// without one before any lane starts.
await warmDev();
stage("devServer", began);

// ---- parts: slugs, instances, the app's base under them ----
const taken = new Set();
const parts = leaves.map(({ entry, node }) => {
  let slug = entry.marker;
  for (let n = 2; taken.has(slug); n++) slug = `${entry.marker}-${n}`;
  taken.add(slug);
  const instance = instanceOf({ name: "Default", selector: node.selector }, instanceFromRead(read, node.element, { backdrop: node.backdrop, room: node.room }));
  return { id: entry.id, marker: entry.marker, name: entry.name, slug, Name: pascal(slug), node, instance, folder: join(partsDir, slug) };
});
// Heaviest first, so a big part starts in the first lane instead of becoming the tail.
parts.sort((a, b) => b.instance.nodes.length - a.instance.nodes.length);

const baselineBegan = Date.now();
mkdirSync(partsDir, { recursive: true });
const kinds = [...new Set(parts.flatMap((part) => part.instance.nodes.map(kindOf)))];
const baseline = await appBaseline(appUrl, kinds, viewport, display);
stage("baseline", baselineBegan);

reporter.send([
  { kind: "phase", phase: "replicating", line: `Replicating ${parts.length} parts against your page` },
  ...parts.map((part) => ({ kind: "queued", id: part.id })),
]);

// ---- lanes ----
const matched = [];
const toFix = [];
const failed = [];
const reused = [];
const queue = [...parts];
const partsBegan = Date.now();
async function lane() {
  for (let part = queue.shift(); part; part = queue.shift()) {
    const partBegan = Date.now();
    try {
      reporter.send([{ kind: "focus", id: part.id }]);
      let outcome = null;
      const twin = libraryMatch(part.instance);
      if (twin) {
        adoptLibraryPart(part, twin);
        outcome = await check(part);
        if (!outcome.matched) step(`${part.slug}: the library's ${twin.slug} looked alike but does not match here; writing it from the page`);
        else reused.push(part.id);
      }
      if (!outcome?.matched) {
        part.reused = null;
        await writeComponent({
          instances: [part.instance],
          faces: read.faces ?? [],
          spec: { slug: part.slug, name: part.name },
          folder: part.folder,
          appUrl,
          viewport,
          display,
          baseline,
          marker: part.marker,
          assets: read.assets ?? {},
        });
        outcome = await check(part);
      }
      part.outcome = outcome;
      const seconds = `${Math.round((Date.now() - partBegan) / 100) / 10} s`;
      if (outcome.matched) {
        matched.push(part.id);
        step(`${part.slug}: ${outcome.states[0].result.verdict} (${seconds})`);
      } else {
        toFix.push({ id: part.id, slug: part.slug, states: outcome.states.map((s) => ({ state: s.state, verdict: s.result?.verdict ?? s.verdict, mismatch: s.result?.mismatch ?? null, clusters: s.result?.clusters?.slice(0, 3) ?? [], error: s.error })) });
        step(`${part.slug}: ${outcome.states.map((s) => s.result?.verdict ?? s.verdict).join(", ")} (${seconds})`);
      }
    } catch (error) {
      // A render caught in a dev-server reload is tried once more; anything else is this part's own failure.
      if (/navigated or closed/.test(error.message) && !part.retried) {
        part.retried = true;
        queue.unshift(part);
        continue;
      }
      failed.push({ id: part.id, slug: part.slug, error: error.message });
      step(`${part.slug}: could not be written (${error.message})`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(options.lanes)) }, lane));
stage("parts", partsBegan);

/** Check one part's states, stream each pass, and the match with its picture. */
async function check(part) {
  const unit = JSON.parse(readFileSync(join(part.folder, "component.json"), "utf8"));
  const outcome = await checkComponent({ unit, slug: part.slug, appUrl, liveMatch, out: join(checksDir, part.slug), codebase, port: Number(options.port) });
  // Each pass goes up with its two pictures, the part as we draw it (the
  // crop is exactly the part's rect) and the same crop with the pixels
  // still differing painted red; the uploads of every state run at once.
  const images = await Promise.all(
    outcome.states.map(async (state) => {
      if (!state.result) return null;
      const [image, diff] = await Promise.all([reporter.upload(readFileSync(state.result.screenshot)), reporter.upload(readFileSync(state.result.diff))]);
      reporter.send([{ kind: "pass", id: part.id, pass: state.result.pass, mismatch: state.result.mismatch, image, diff }]);
      return image;
    }),
  );
  if (outcome.matched) {
    const first = outcome.states[0].result;
    const [x, y, w, h] = first.rect;
    reporter.send([{ kind: "matched", id: part.id, image: images[0], rect: { x, y, w, h } }]);
  }
  return outcome;
}

// ---- the page: sections and packaging composed around the parts ----
const composeBegan = Date.now();
reporter.send([{ kind: "phase", phase: "composing", line: "Putting the page together around its parts" }]);
const built = parts.filter((part) => part.outcome);
const page = await composePage(built);
stage("compose", composeBegan);

const pageBegan = Date.now();
const pageCheck = await settled(checkPage);
stage("pageCheck", pageBegan);

// ---- the library learns the parts it lacked ----
const libraryBegan = Date.now();
const learned = learnParts(built.filter((part) => part.outcome.matched && part.reused === null));
stage("library", libraryBegan);

// ---- the gate: the copy is usable now; what is left is the tail ----
const pageArea = viewport.width * viewport.height * display.dpr * display.dpr;
const areaOf = (part) => Math.max(1, Math.round((part.node.rect?.[2] ?? 1) * (part.node.rect?.[3] ?? 1)));
record(tailFile(codebase, briefId), {
  kind: "phase",
  phase: "copy",
  items: parts.map((part) => ({ item: part.slug, weight: areaOf(part), matched: statusOf(part) === "matched" })),
});
for (const entry of toFix) {
  const worst = entry.states.find((s) => s.verdict === "differs") ?? entry.states[0];
  const small = worst && classifyPart({ verdict: worst.verdict, mismatch: worst.mismatch, pageArea });
  entry.rule = small?.tail ? "small" : "gate";
  entry.reason = small?.tail ? `${small.reason.replace("its area", "the page")}` : "still differs at the gate";
  record(tailFile(codebase, briefId), { kind: "item", item: entry.slug, rule: entry.rule, reason: entry.reason });
  step(`${entry.slug} left for later: ${entry.reason}`);
}
for (const entry of failed) {
  record(tailFile(codebase, briefId), { kind: "item", item: entry.slug, rule: "gate", reason: entry.error });
  step(`${entry.slug} left for later: ${entry.error}`);
}
const pagePct = parseFloat(pageCheck?.pct ?? "100");
const proceed = pageCheck?.verdict !== "failed" && Number.isFinite(pagePct) && pagePct <= TAIL.PAGE_PROCEED_PCT;
let gateLine = `Usable now: ${matched.length} of ${parts.length} parts match and the page differs by ${pageCheck?.pct ?? "?"}`;
if (proceed) gateLine += "; the change is written on this copy";
else gateLine += `; the copy is not usable yet (${pageCheck?.error ?? `the page differs by more than ${TAIL.PAGE_PROCEED_PCT}%`})`;
if (toFix.length + failed.length > 0) gateLine += `. ${toFix.length + failed.length} part${toFix.length + failed.length === 1 ? "" : "s"} left for later, each with its reason above: the long tail, for background units.`;
step(gateLine);

await reporter.flush();
stopDev();
console.log(
  JSON.stringify({
    seconds: Math.round((Date.now() - started) / 100) / 10,
    parts: parts.map((part) => ({ id: part.id, slug: part.slug, marker: part.marker, reused: part.reused ?? null, status: statusOf(part) })),
    matched,
    toFix,
    failed,
    reused,
    page: pageCheck,
    learned,
    fitted: page.rounds,
    timings,
    gate: { proceed, line: gateLine },
  }),
);
process.exit(0);

// ---- helpers ----

function statusOf(part) {
  if (!part.outcome) return "failed";
  if (part.outcome.matched) return "matched";
  return "differs";
}

async function warmDev() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const page = await headlessPage(`${appUrl}/`, { ...viewport, display });
    try {
      // A load that stands for over a second without the page going away
      // under it: a reload wipes the token.
      await evaluate(page.page, "window.__protoWarm = true");
      await new Promise((r) => setTimeout(r, 1500));
      const still = await evaluate(page.page, "window.__protoWarm === true").catch(() => false);
      if (still) return;
    } finally {
      await page.close().catch(() => {});
    }
  }
}

/** A library component whose fingerprint is this instance's, or null. */
function libraryMatch(instance) {
  const modules = join(library, "src", "components");
  if (!existsSync(modules)) return null;
  const mine = shapeFingerprint(instance.nodes);
  for (const slug of readdirSync(modules)) {
    const unitPath = join(modules, slug, "component.json");
    if (!existsSync(unitPath)) continue;
    const unit = JSON.parse(readFileSync(unitPath, "utf8"));
    if (!unit.shape) continue;
    const same = unit.shape.tags === mine.tags && Object.entries(mine.root).every(([k, v]) => unit.shape.root[k] === v);
    if (same) return { slug, folder: join(modules, slug), unit };
  }
  return null;
}

/**
 * Use a library component as this part: its folder copied into the
 * workspace, its default state pointed at this part's live element, its
 * root carrying the part's marker.
 */
function adoptLibraryPart(part, twin) {
  rmSync(part.folder, { recursive: true, force: true });
  cpSync(twin.folder, part.folder, { recursive: true });
  const module = readdirSync(part.folder).find((name) => /^[A-Z][A-Za-z0-9]*\.tsx$/.test(name));
  const TwinName = module.replace(/\.tsx$/, "");
  const source = readFileSync(join(part.folder, module), "utf8");
  const rootOpen = /className=\{cx\(styles\.root,[^}]*\}/;
  if (!rootOpen.test(source)) throw new Error(`${twin.slug} was not written by tools/snapshot.mjs; it cannot carry a marker`);
  // The module takes this part's name, since App.tsx imports every part as
  // <Name> from src/parts/<slug>/<Name>.tsx; the twin's name goes with its folder.
  const renamed = source.replace(rootOpen, (m) => `${m} data-proto-id=${JSON.stringify(part.marker)}`).replaceAll(TwinName, part.Name);
  rmSync(join(part.folder, module));
  rmSync(join(part.folder, `${TwinName}.module.css`), { force: true });
  writeFileSync(join(part.folder, `${part.Name}.tsx`), renamed);
  if (existsSync(join(twin.folder, `${TwinName}.module.css`))) copyFileSync(join(twin.folder, `${TwinName}.module.css`), join(part.folder, `${part.Name}.module.css`));
  const unit = { ...twin.unit, states: twin.unit.states.map((state, i) => (i === 0 ? { ...state, live: { selector: part.node.selector } } : { name: state.name, props: state.props })) };
  writeFileSync(join(part.folder, "component.json"), JSON.stringify(unit, null, 2) + "\n");
  part.reused = twin.slug;
}

/**
 * src/App.tsx and src/App.module.css: the page's elements from <body>
 * down to each part's root, each with the computed style the read
 * captured (what differs from the workspace's base), parts as their
 * components with the margins and offsets of the element they replace,
 * then fitted against the read: a box that comes out another size is
 * pinned, up to three rounds.
 */
async function composePage(builtParts) {
  const partByElement = new Map(builtParts.map((part) => [part.node.element, part]));
  const treeByElement = new Map(tree.nodes.map((node) => [node.element, node]));
  const nodes = [];
  const collect = (i, parent) => {
    const el = read.elements[i];
    const style = styleOf(read, el.style);
    if (style.display === "none") return null;
    const k = nodes.length;
    const treeNode = treeByElement.get(i) ?? null;
    // The body's own box is the page's root div; a frame is an empty div
    // of its size; a custom element (a framework's own tag) is a div
    // with its styles, since JSX knows no such tag.
    let tag = el.tag;
    if (tag === "body" || tag === "iframe" || tag.includes("-")) tag = "div";
    const node = {
      i: k,
      tag,
      framed: el.tag === "iframe",
      svg: el.svg,
      parent,
      attrs: { ...el.attrs },
      children: [],
      style,
      pseudo: Object.fromEntries(Object.entries(el.pseudo).map(([which, values]) => [which, styleOf(read, values)])),
      value: el.value,
      rect: [...el.rect],
      part: partByElement.get(i) ?? null,
      treeId: treeNode?.id ?? null,
      marker: treeNode && roleOf.get(treeNode.id)?.role === "section" ? roleOf.get(treeNode.id).marker : null,
    };
    nodes.push(node);
    if (node.part || node.framed) return k;
    for (const child of el.children) {
      if (child.text !== undefined) node.children.push({ text: child.text });
      else {
        const at = collect(child.node, k);
        if (at !== null) node.children.push({ node: at });
      }
    }
    return k;
  };
  collect(0, -1);
  const fit = nodes.map(() => ({}));
  const names = nameNodes(nodes).map((name, k) => (k === 0 ? "page" : name));
  const pageDir = join(workspace.path, "src", "page");
  rmSync(pageDir, { recursive: true, force: true });
  mkdirSync(pageDir, { recursive: true });
  // Images outside every part: copied beside the page and imported.
  const images = new Map();
  for (const node of nodes) {
    if (node.tag !== "img" || !node.attrs.src || node.part) continue;
    const absolute = new URL(node.attrs.src, read.page.url).toString();
    if (images.has(absolute)) continue;
    const captured = read.assets?.[absolute];
    if (!captured || !existsSync(captured)) continue;
    const ident = `image${images.size + 1}`;
    const file = `${ident}${/\.[a-z0-9]+$/i.exec(captured)?.[0] ?? ".png"}`;
    copyFileSync(captured, join(pageDir, file));
    images.set(absolute, { ident, file });
  }
  const imageOf = (node) => images.get(new URL(node.attrs.src, read.page.url).toString());
  const kindsHere = [...new Set(nodes.filter((n) => !n.part).map(kindOf))].filter((kind) => !baseline[kind]);
  if (kindsHere.length > 0) Object.assign(baseline, await appBaseline(appUrl, kindsHere, viewport, display));

  const emit = () => {
    const declared = nodes.map((node, k) => {
      const out = layoutOf(node, nodes, fit[k], k === 0, null);
      if (node.framed) {
        out.width = `${node.rect[2]}px`;
        out.height = `${node.rect[3]}px`;
      }
      return out;
    });
    const css = [];
    const lines = [];
    const indent = (d) => "  ".repeat(d);
    for (const [k, node] of nodes.entries()) {
      if (node.part) {
        // The part's place in the page: what the element it replaces had
        // around it, on top of the part's own root (two classes beat one).
        const slot = {};
        for (const [name, value] of Object.entries(declared[k])) if (/^(margin-|top$|right$|bottom$|left$|width$|height$|flex-basis$)/.test(name)) slot[name] = value;
        if (node.style.position !== "static" && node.style.position !== "relative") slot.position = node.style.position;
        for (const name of ["flex-grow", "flex-shrink", "align-self", "justify-self", "order", "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end", "z-index"]) {
          if (node.style[name] !== baseline[kindOf(node)]?.style[name]) slot[name] = node.style[name];
        }
        css.push(cssBlock(`.page .${names[k]}`, slot));
        continue;
      }
      css.push(cssBlock(`.${names[k]}`, propsFor(node, nodes, baseline, declared[k], k === 0)));
      for (const which of Object.keys(node.pseudo)) css.push(cssBlock(`.${names[k]}${which}`, pseudoProps(node, which, baseline)));
    }
    const render = (k, depth) => {
      const node = nodes[k];
      if (node.part) {
        lines.push(`${indent(depth)}<${node.part.Name} className={styles[${JSON.stringify(names[k])}]} />`);
        return;
      }
      const attrs = [`className={styles[${JSON.stringify(names[k])}]}`];
      if (node.treeId) attrs.push(`data-node=${JSON.stringify(node.treeId)}`);
      if (node.marker) attrs.push(`data-proto-id=${JSON.stringify(node.marker)}`);
      // A frame's box stands in for it, empty: nothing of another site loads in the prototype.
      const attributes = node.framed ? {} : node.attrs;
      for (const [name, value] of Object.entries(attributes)) {
        const jsxName = jsxAttr(name, node);
        if (!jsxName || jsxName === "data-proto-id") continue;
        if (node.tag === "img" && name === "src") {
          const img = imageOf(node);
          if (img) attrs.push(`src={${img.ident}}`);
          continue;
        }
        if (name === "type" && node.tag === "button") continue;
        if (name === "disabled" || name === "checked") {
          attrs.push(name === "checked" ? "defaultChecked" : name);
          continue;
        }
        attrs.push(`${jsxName}={${JSON.stringify(value)}}`);
      }
      if (node.tag === "button") attrs.push(`type="button"`);
      if (node.tag === "input" || node.tag === "textarea") attrs.push("readOnly");
      const open = `<${node.tag} ${attrs.join(" ")}`;
      const kids = node.children.filter((child) => child.node !== undefined || child.text !== "");
      if (kids.length === 0) {
        lines.push(`${indent(depth)}${open} />`);
        return;
      }
      lines.push(`${indent(depth)}${open}>`);
      const flexParent = /flex|grid/.test(node.style.display);
      for (const child of node.children) {
        if (child.node !== undefined) {
          render(child.node, depth + 1);
          continue;
        }
        if (child.text.trim() === "") {
          if (flexParent || child.text === "" || node.svg) continue;
          lines.push(`${indent(depth + 1)}{" "}`);
        } else lines.push(`${indent(depth + 1)}{${JSON.stringify(child.text)}}`);
      }
      lines.push(`${indent(depth)}</${node.tag}>`);
    };
    render(0, 2);
    const imports = builtParts.map((part) => `import ${part.Name} from "./parts/${part.slug}/${part.Name}";`).sort();
    const tsx = `import styles from "./App.module.css";
${imports.join("\n")}
${[...images.values()].map((img) => `import ${img.ident} from "./page/${img.file}";`).join("\n")}

/**
 * ${read.page.title || "The page"}, as the product renders it
 * (${read.page.url.split("?")[0]}), composed by tools/replicate.mjs: the
 * page's own boxes with their computed styles around each part. Sections
 * carry the data-proto-id the build named them by; each part carries its
 * own. Preview states come with the change built on top of this copy.
 */
export function App() {
  return (
${lines.join("\n")}
  );
}
`;
    writeFileSync(join(workspace.path, "src", "App.tsx"), tsx.replace(/\n\n\n+/g, "\n\n"));
    writeFileSync(join(workspace.path, "src", "App.module.css"), css.filter(Boolean).join("\n"));
  };
  emit();
  const manifestPath = join(workspace.path, "public", "prototype.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.states = [{ id: "default", title: "Default", description: "The page as it is today" }];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  // Fitting: every box the tree knows, and every part's root, measured in
  // the composed page against the read; a box another size is pinned.
  let rounds = 0;
  for (let round = 0; round < 3; round++) {
    const measured = await settled(measurePage);
    if (!measured) break;
    let changed = false;
    const partOrder = new Map();
    for (const [k, node] of nodes.entries()) {
      let mine = null;
      if (node.part) {
        const n = partOrder.get(node.part.marker) ?? 0;
        partOrder.set(node.part.marker, n + 1);
        mine = measured.parts[node.part.marker]?.[n] ?? null;
      } else if (node.treeId) mine = measured.nodes[node.treeId] ?? null;
      if (!mine || k === 0) continue;
      const [, , lw, lh] = node.rect;
      const [, , mw, mh] = mine;
      const parent = nodes[node.parent];
      if (Math.abs(lw - mw) > 0.5 && fit[k].width === undefined) {
        fit[k].width = fillsParent(node, parent, "width") ? "100%" : `${lw}px`;
        changed = true;
      }
      if (Math.abs(lh - mh) > 0.5 && fit[k].height === undefined) {
        fit[k].height = `${lh}px`;
        changed = true;
      }
    }
    rounds = round + 1;
    if (!changed) break;
    emit();
  }
  return { rounds, nodes: nodes.length };
}

// Whether a box fills its parent's content box along one axis.
function fillsParent(node, parent, axis) {
  if (!parent) return false;
  const st = parent.style;
  const [a, b] = axis === "width" ? ["left", "right"] : ["top", "bottom"];
  const inner = parent.rect[axis === "width" ? 2 : 3] - parseFloat(st[`padding-${a}`]) - parseFloat(st[`padding-${b}`]) - parseFloat(st[`border-${a}-width`]) - parseFloat(st[`border-${b}-width`]);
  const own = node.rect[axis === "width" ? 2 : 3] + parseFloat(node.style[`margin-${a}`]) + parseFloat(node.style[`margin-${b}`]);
  return Math.abs(own - inner) <= 0.5;
}

/**
 * A read of the composed page that survives the dev server's reloads:
 * the files just written reach the watcher a moment later and every
 * open page reloads under a read, so a read caught by one is made again.
 */
async function settled(readPage) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readPage();
    } catch (error) {
      if (!/navigated or closed/.test(error.message) || attempt >= 3) throw error;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

/** The composed page's boxes: tree nodes by id, parts by marker in document order. */
async function measurePage() {
  const page = await headlessPage(`${appUrl}/`, { ...viewport, display });
  try {
    return await evaluate(
      page.page,
      `new Promise((done) => { const until = Date.now() + 15000; const tick = () => { if (document.querySelector('[data-node]')) { Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]).then(() => { const rect = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }; const nodes = {}; for (const e of document.querySelectorAll('[data-node]')) nodes[e.dataset.node] = rect(e); const parts = {}; for (const e of document.querySelectorAll('[data-proto-id]')) { if (e.hasAttribute('data-node')) continue; (parts[e.dataset.protoId] ??= []).push(rect(e)); } done({ nodes, parts }); }); } else if (Date.now() > until) done(null); else setTimeout(tick, 50); }; tick(); })`,
    );
  } finally {
    await page.close();
  }
}

/** The whole page against the run's frame of the reference: one diff. */
async function checkPage() {
  const frame = framePaths(codebase);
  if (!existsSync(frame.png)) return null;
  mkdirSync(checksDir, { recursive: true });
  const mine = join(checksDir, "page.png");
  const diff = join(checksDir, "page-diff.png");
  const page = await headlessPage(`${appUrl}/`, { ...viewport, display });
  try {
    // Bounded: an App.tsx the dev server cannot serve (an import it cannot
    // resolve) is the page's failure, not a hang.
    const mounted = await evaluate(page.page, "new Promise((done) => { const until = Date.now() + 15000; const tick = () => { if (document.querySelector('[data-node]')) done(true); else if (Date.now() > until) done(false); else setTimeout(tick, 50); }; tick(); })");
    if (!mounted) return { verdict: "failed", mismatch: null, pct: null, clusters: [], error: `the composed page did not mount within 15 s (${join(buildDir, "dev.log")} says why)` };
    await evaluate(page.page, "document.fonts.ready.then(() => document.fonts.status)");
    await stableShot(page.page, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, mine);
  } finally {
    await page.close();
  }
  const result = diffPngs(frame.png, mine, { diffPath: diff, threshold: THRESHOLD, dpr: display.dpr });
  let verdict = "differs";
  if (result.diffPixels === 0) verdict = "match";
  else if (result.diffPixels <= 0.003 * result.width * result.height) verdict = "faint";
  return { verdict, mismatch: result.diffPixels, pct: result.pct, clusters: result.clusters.slice(0, 6), screenshot: mine, diff };
}

/**
 * Parts written from this page that matched it go into the library as
 * components (the library contract), so the next build reuses them:
 * the folder copied, its states without this page's selectors, and a
 * sentence that it was checked in the build, not in the library.
 */
function learnParts(newParts) {
  const modules = join(library, "src", "components");
  if (!existsSync(join(library, "public", "manifest.json"))) return [];
  const learned = [];
  for (const part of newParts) {
    const dest = join(modules, part.slug);
    if (existsSync(dest)) continue;
    cpSync(part.folder, dest, { recursive: true });
    const unit = JSON.parse(readFileSync(join(dest, "component.json"), "utf8"));
    unit.states = unit.states.map(({ name, props }) => ({ name, props }));
    unit.unverified = "Checked against the page in a prototype build, not in the library";
    writeFileSync(join(dest, "component.json"), JSON.stringify(unit, null, 2) + "\n");
    const write = (...rest) => spawnSync(process.execPath, [join(kit, "tools", "library.mjs"), ...rest], { encoding: "utf8" });
    const listed = write("inventory", library, JSON.stringify([{ slug: part.slug, name: part.name }]));
    const done = listed.status === 0 ? write("component", library, part.slug, "status", "done", "--activity", `Learned ${part.name} from a prototype build`) : listed;
    if (done.status !== 0) {
      rmSync(dest, { recursive: true, force: true });
      step(`${part.slug}: the library did not take it (${done.stderr.trim().split("\n").pop()})`);
      continue;
    }
    learned.push(part.slug);
  }
  return learned;
}
