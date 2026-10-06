#!/usr/bin/env node
/**
 * A picture of the prototype as it renders, for the agent to look at:
 * any preview state, any variant, one marked part or the whole page. The
 * one way to see the prototype; never a browser or a screenshot of your
 * own (Chrome's --screenshot mode does not exit, and opening the kit's
 * headless Chrome by hand disturbed the checks that use it).
 *
 * Usage: node tools/look.mjs <workspace> [--state <id>] [--variant <set>=<id>]... [--part <marker> | --page] [--pad 24]
 *
 * Without --part or --page it pictures the variant sets' parts when a
 * --variant is given, else the whole page. Pictures go to the build
 * folder (<build>/looks/), never into public/. Prints one JSON line:
 * { seconds, pictures: [{ file, url, rect }], missing }.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildOfWorkspace } from "./build-folder.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { launchedDisplayOr, waitForMarkers } from "./views.mjs";

const USAGE = "usage: node tools/look.mjs <workspace> [--state <id>] [--variant <set>=<id>]... [--part <marker> | --page] [--pad 24]";
const args = process.argv.slice(2);
const options = { variants: [], pad: "24" };
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--page") options.page = true;
  else if (args[i] === "--variant") options.variants.push(args[++i]);
  else if (args[i].startsWith("--")) options[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [workspace] = positional;
if (!workspace || !existsSync(join(workspace, "public", "prototype.json"))) {
  console.error(USAGE);
  process.exit(1);
}
const started = Date.now();
const build = buildOfWorkspace(workspace);
const viewport = build?.tree?.viewport ?? { width: 1280, height: 800 };
const display = launchedDisplayOr(viewport);
const looksDir = join(build ? build.dir : join(workspace, ".proto-checks"), "looks");
mkdirSync(looksDir, { recursive: true });
const dev = await ensureDevServer({ workspace, logPath: join(looksDir, "..", "dev.log") });

const query = new URLSearchParams();
if (options.state) query.set("state", options.state);
for (const v of options.variants) {
  const [set, id] = v.split("=");
  if (!set || !id) {
    console.error(`--variant is <set>=<id>: "${v}"`);
    process.exit(1);
  }
  query.set(`v.${set}`, id);
}
const url = `${dev.url}/${query.size ? `?${query}` : ""}`;
const part = options.part ?? (options.page ? null : options.variants[0]?.split("=")[0] ?? null);
const pad = Number(options.pad);
const name = [part ?? "page", ...options.variants.map((v) => v.replace("=", "-")), options.state ?? "default"].join("--").replace(/[^a-z0-9.-]+/gi, "-");
const file = join(looksDir, `${name}.png`);

const missing = [];
const pictures = [];
const opened = await headlessPage(url, { ...viewport, display });
try {
  const marks = await waitForMarkers(opened.page);
  let clip;
  let rect = null;
  if (part) {
    const mine = marks?.marks.filter((m) => m.id === part && !m.hidden && m.rect[2] > 0 && m.rect[3] > 0) ?? [];
    if (mine.length === 0) missing.push({ part, why: marks === null ? "the app did not mount" : `nothing marked ${part} in this view` });
    else {
      const x0 = Math.min(...mine.map((m) => m.rect[0]));
      const y0 = Math.min(...mine.map((m) => m.rect[1]));
      const x1 = Math.max(...mine.map((m) => m.rect[0] + m.rect[2]));
      const y1 = Math.max(...mine.map((m) => m.rect[1] + m.rect[3]));
      rect = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
      clip = { x: Math.max(0, Math.floor(x0 - pad)), y: Math.max(0, Math.floor(y0 - pad)) };
      clip.width = Math.min(viewport.width, Math.ceil(x1 + pad)) - clip.x;
      clip.height = Math.min(viewport.height, Math.ceil(y1 + pad)) - clip.y;
    }
  }
  if (!part || clip) {
    await stableShot(opened.page, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, file, clip);
    pictures.push({ file, url, rect });
  }
} finally {
  await opened.close().catch(() => {});
  dev.stop();
}
console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 100) / 10, pictures, missing }));
process.exit(0);
