import { acquireProcessLock } from "../process-lock.mjs";
// Start or find the debug Chrome without taking focus.
// Headless by default: no OS window exists to steal focus. Visible sign-in
// requires both --visible and PROTO_ALLOW_FOREGROUND=1 from an explicit request.
// Usage: node tools/chrome.mjs [port] [profile-dir] [--visible]
//
// It draws in sRGB whatever screen it is on (--force-color-profile=srgb).
// Left to itself Chrome draws through the screen's own colour profile,
// and a screenshot returns the screen's pixels: on an external monitor
// with its own profile Bootstrap's rgb(51, 122, 183) came back as
// rgb(45, 111, 174), so every component of an import differed from its
// replica (drawn by the headless Chrome in plain sRGB) in nearly every
// pixel while every computed value agreed. In sRGB, both draw alike on
// any screen, and tools/cdp/headless.mjs follows (its colour gamut
// then reads sRGB).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { protoHome } from "../proto-home.mjs";

const args = process.argv.slice(2);
const visible = args.includes("--visible");
const positional = args.filter(arg => arg !== "--visible");
const port = Number(positional[0] || 9333);
const profile = positional[1] || join(protoHome(), "chrome");
if (visible && process.env.PROTO_ALLOW_FOREGROUND !== "1") {
  throw new Error("Visible Chrome requires explicit user authorization and PROTO_ALLOW_FOREGROUND=1.");
}

async function alive() {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

const releaseStartup = await acquireProcessLock(join(protoHome(), `chrome-${port}.lock`));
if (await alive()) {
  const version = await (await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
  const isHeadless = /HeadlessChrome/.test(version["User-Agent"] || "");
  if (visible === isHeadless) {
    await releaseStartup();
    throw new Error(`Chrome on ${port} is ${isHeadless ? "headless" : "visible"}; close the dedicated Proto browser before explicitly switching modes. It will not be activated or replaced automatically.`);
  }
  // One launched before the colour profile was forced keeps drawing through the screen's.
  let srgb = true;
  try {
    srgb = execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`--remote-debugging-port=${port}`) && !l.includes("--type=")).every((l) => l.includes("--force-color-profile=srgb"));
  } catch {}
  console.log(`chrome already listening on ${port}${srgb ? "" : "; it was launched without --force-color-profile=srgb, so its captures follow the screen's colour profile: quit it and run this again when no import is running"}`);
  await releaseStartup();
  process.exit(0);
}

mkdirSync(profile, { recursive: true });
const chromeArgs = [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--force-color-profile=srgb",
  "about:blank",
];
if (visible) {
  execFileSync("open", ["-g", "-n", "-a", "Google Chrome", "--args", ...chromeArgs]);
} else {
  const child = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--mute-audio", ...chromeArgs], { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
}

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await alive()) {
    console.log(`chrome up on ${port}, profile ${profile}, launched ${visible ? "visible for explicit user interaction" : "headless (no visible window)"}`);
    await releaseStartup();
    process.exit(0);
  }
}
console.error("chrome did not come up in 10s");
await releaseStartup();
process.exit(1);
