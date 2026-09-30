// The Proto window, shared by every lane of an import.
//
// One window, one page, many readers: an import writes and checks a
// component in each of several lanes at once. Two things go wrong when
// they read the page at the same moment. A pseudo-class one lane holds
// (the hover on a button) shows in another lane's read or capture of
// anything around it; and Chrome captures a background tab one frame
// at a time, so eight lanes capturing it queue behind each other.
//
// So every read of the live page happens under one lock (`withLive`),
// and the resting page is captured once (`takeFrame`) and cut from for
// every state that holds no pseudo-class (`frameCrop`). Only held
// states capture the live page again, one at a time.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./capture.mjs";
import { evaluate } from "./cdp.mjs";
import { decodePng, encodePng } from "./png.mjs";

const LOCK = join(process.env.HOME ?? "", ".proto", ".live-lock");
// The lock folder names its holder, so a lock whose process is gone
// (a lane import.mjs stopped after two minutes, a crashed tool) is
// taken over at once instead of holding every other lane behind it.
const HOLDER = join(LOCK, "pid");
// A read takes well under a second, a held state's capture a few; a
// lock this old with a live holder belongs to a process that hung.
const STALE_MS = 30_000;
// The resting page is trusted this long; after it, captures go live again.
const FRAME_MAX_AGE_MS = 10 * 60_000;

// Whether the process that took the lock is still running. A lock
// without its pid yet was taken a moment ago and is treated as held.
function holderAlive() {
  let pid;
  try {
    pid = Number(readFileSync(HOLDER, "utf8"));
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

/** Run `work` while holding the Proto window's read lock. */
export async function withLive(work) {
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(HOLDER, String(process.pid));
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(LOCK).mtimeMs;
      } catch {}
      if (!holderAlive() || age > STALE_MS) rmSync(LOCK, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 40));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

/** Where a codebase's resting frame lives: the picture and what it was taken at. */
export const framePaths = (codebase) => {
  const run = join(process.env.HOME ?? "", ".proto", codebase, "run");
  return { png: join(run, "live-frame.png"), pixels: join(run, "live-frame.rgba"), meta: join(run, "live-frame.json") };
};

// The boxes of the deepest elements the pointer is over, if it is over the page.
const HOVERED = "[...document.querySelectorAll(':hover')].filter((e) => !e.querySelector(':hover') && e !== document.body && e !== document.documentElement).map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })";

// Where the page stands: a frame is only good for the same viewport and scroll.
const STANDING = "JSON.stringify([innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio])";

/**
 * Capture the resting page once: every CSS transition on it finished
 * first (the window is behind others and never advances them), under
 * the lock, so no lane's held state is in it. `also` runs under the
 * same lock before the shot and its result comes back as `read`.
 */
export async function takeFrame(live, codebase, { also } = {}) {
  let hovered = [];
  let read;
  const paths = framePaths(codebase);
  mkdirSync(join(paths.png, ".."), { recursive: true });
  await withLive(async () => {
    // A build's one read of the page runs under this same lock, just
    // before the shot, so the frame and the read see the same page.
    if (also) read = await also();
    await evaluate(live, "(() => { for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish(); return true; })()");
    await stableShot(live, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, paths.png);
    // Kept as raw pixels too: every resting state is cut from them by
    // reading only its rows, never by decoding the whole page again.
    const decoded = decodePng(readFileSync(paths.png));
    writeFileSync(paths.pixels, decoded.data);
    const standing = await evaluate(live, STANDING);
    // Anything the pointer rests on shows its hover look in the frame: a
    // resting state is never cut from there (frameCrop captures it live).
    hovered = await evaluate(live, HOVERED);
    writeFileSync(paths.meta, JSON.stringify({ standing, hovered, size: [decoded.width, decoded.height], at: Date.now() }) + "\n");
  });
  return { ...paths, hovered, read };
}

/**
 * The clip cut from the resting frame, when there is a frame for this
 * codebase, young enough, taken where the page still stands; false
 * otherwise (the caller captures the live page).
 */
export async function frameCrop(live, codebase, clip, out) {
  if (!codebase) return false;
  const paths = framePaths(codebase);
  if (!existsSync(paths.png) || !existsSync(paths.meta)) return false;
  const meta = JSON.parse(readFileSync(paths.meta, "utf8"));
  if (Date.now() - meta.at > FRAME_MAX_AGE_MS) return false;
  if ((await evaluate(live, STANDING)) !== meta.standing) return false;
  const overlaps = ([x, y, w, h]) => x < clip.x + clip.width && clip.x < x + w && y < clip.y + clip.height && clip.y < y + h;
  if ((meta.hovered ?? []).some(overlaps)) return false;
  if (!existsSync(paths.pixels) || !meta.size) return false;
  const dpr = JSON.parse(meta.standing)[4];
  const [frameWidth, frameHeight] = meta.size;
  // The clip within the frame, in device pixels; what the viewport cuts off is left out.
  const x = Math.max(0, Math.round(clip.x * dpr));
  const y = Math.max(0, Math.round(clip.y * dpr));
  const width = Math.min(frameWidth, Math.round((clip.x + clip.width) * dpr)) - x;
  const height = Math.min(frameHeight, Math.round((clip.y + clip.height) * dpr)) - y;
  if (width <= 0 || height <= 0) return false;
  const data = new Uint8Array(width * height * 4);
  const fd = openSync(paths.pixels, "r");
  try {
    for (let row = 0; row < height; row++) readSync(fd, data, row * width * 4, width * 4, ((y + row) * frameWidth + x) * 4);
  } finally {
    closeSync(fd);
  }
  writeFileSync(out, encodePng({ width, height, data }));
  return true;
}
