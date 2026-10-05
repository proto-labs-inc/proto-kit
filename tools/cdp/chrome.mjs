// Start or find the debug Chrome without taking focus.
// "open -g" launches the app in the background. The window opens behind
// the user's current work and never becomes the front window.
// Usage: node tools/chrome.mjs [port] [profile-dir]
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
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const port = Number(process.argv[2] || 9333);
const profile = process.argv[3] || `${process.env.HOME}/.proto/chrome`;

async function alive() {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

if (await alive()) {
  // One launched before the colour profile was forced keeps drawing through the screen's.
  let srgb = true;
  try {
    srgb = execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`--remote-debugging-port=${port}`) && !l.includes("--type=")).every((l) => l.includes("--force-color-profile=srgb"));
  } catch {}
  console.log(`chrome already listening on ${port}${srgb ? "" : "; it was launched without --force-color-profile=srgb, so its captures follow the screen's colour profile: quit it and run this again when no import is running"}`);
  process.exit(0);
}

mkdirSync(profile, { recursive: true });
execFileSync("open", [
  "-g", // do not bring the app to the foreground
  "-n",
  "-a", "Google Chrome",
  "--args",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--force-color-profile=srgb",
  "about:blank",
]);

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await alive()) {
    console.log(`chrome up on ${port}, profile ${profile}, launched in background`);
    process.exit(0);
  }
}
console.error("chrome did not come up in 10s");
process.exit(1);
