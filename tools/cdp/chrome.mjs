// Start or find the debug Chrome without taking focus.
// "open -g" launches the app in the background. The window opens behind
// the user's current work and never becomes the front window.
// Usage: node tools/chrome.mjs [port] [profile-dir]
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
  console.log(`chrome already listening on ${port}`);
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
