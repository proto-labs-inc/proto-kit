#!/usr/bin/env node
// Capture a screen's reference PNGs from the live source page, drawn
// exactly as tools/verify-screen.mjs draws the copy (render-profile.mjs):
// CSS viewport width x height, 1x, no scrollbars, focused, fonts and
// motion settled. Uses the build's own signed-in source window; restores
// its viewport, scrollbars and media afterwards.
//
// Usage: node tools/cdp/reference.mjs <out-dir> --widths 390,768,1440
//          [--height 900] [--capture '<capture profile json>'] [--name <prefix>]
//          --browser-session <path>
// Writes <out-dir>/<prefix><width>.png (prefix defaults to none) at the
// page's current state, scrolled to the top, and prints the
// { width: path } map for a scenario's `references`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect, evaluate } from "./cdp.mjs";
import { browserArguments, browserSessionPath, readSession } from "./session-context.mjs";
import { acquireSourceSession } from "./source-session.mjs";
import { SCREEN_RENDER, applyScreenRender, clearScreenRender, settleForCapture } from "./render-profile.mjs";
import { captureProfileFor, sampleAnimations, sampleVideos } from "../verify-screen.mjs";

/** Capture references on an open CDP page; returns { [width]: path }. */
export async function captureReferences(page, { outDir, widths, height = 900, capture = {}, name = "" }) {
  const profile = captureProfileFor({}, { capture });
  mkdirSync(outDir, { recursive: true });
  const written = {};
  try {
    if (profile.reducedMotion !== undefined) {
      // Same as the verifier: the preference holds before the document's scripts run.
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: profile.reducedMotion }] });
      await page.send("Page.enable");
      const loaded = page.once("Page.loadEventFired");
      await page.send("Page.reload");
      await loaded;
    }
    for (const width of widths) {
      await applyScreenRender(page, { width, height });
      const end = Date.now() + 5000;
      while ((await evaluate(page, `innerWidth === ${width} && innerHeight === ${height}`)) !== true) {
        if (Date.now() > end) throw new Error(`The source page did not take a ${width}x${height} viewport`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await evaluate(page, "window.scrollTo(0, 0), true");
      await settleForCapture(page, evaluate);
      if (profile.animationTimeMs !== undefined) await evaluate(page, `(${sampleAnimations.toString()})(document, ${profile.animationTimeMs})`);
      if (profile.videoTimeMs !== undefined) await evaluate(page, `(${sampleVideos.toString()})(document, ${profile.videoTimeMs})`);
      await evaluate(page, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const out = resolve(join(outDir, `${name}${width}.png`));
      writeFileSync(out, Buffer.from(shot.data, "base64"));
      written[width] = out;
    }
  } finally {
    await clearScreenRender(page);
    if (profile.reducedMotion !== undefined) await page.send("Emulation.setEmulatedMedia", { features: [] }).catch(() => {});
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = browserArguments();
  const flag = (key) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
  const outDir = args[0];
  const widths = (flag("--widths") ?? "").split(",").filter(Boolean).map(Number);
  const height = Number(flag("--height") ?? 900);
  if (!outDir || outDir.startsWith("--") || !widths.length || widths.some((w) => !Number.isInteger(w) || w < 1) || !Number.isInteger(height)) {
    console.error("usage: node tools/cdp/reference.mjs <out-dir> --widths 390,768,1440 [--height 900] [--capture '<json>'] [--name <prefix>] --browser-session <path>");
    process.exit(1);
  }
  if (!browserSessionPath()) throw new Error("Pass --browser-session <path> from product-page.mjs");
  const session = readSession();
  if (!session) throw new Error("No source session at --browser-session; open it with product-page.mjs first");
  const { tab } = await acquireSourceSession(session.requestedUrl, session.port);
  const page = await connect(tab.webSocketDebuggerUrl);
  try {
    const written = await captureReferences(page, {
      outDir, widths, height, name: flag("--name") ?? "",
      capture: flag("--capture") ? JSON.parse(flag("--capture")) : {},
    });
    console.log(JSON.stringify({ render: { ...SCREEN_RENDER, height }, references: written }, null, 2));
  } finally {
    page.close();
  }
}
