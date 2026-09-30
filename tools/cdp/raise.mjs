// Bring the Proto window to the front on the tab that needs the user,
// for the one moment they must act in it (signing in to their product).
// The kit otherwise never raises the window: it reads it from behind.
//
// Usage: node tools/cdp/raise.mjs <url-substring> [port]
//   Activates the tab and un-minimises its window over the debug port,
//   then asks macOS to put that Chrome (found by the process listening
//   on the port) in front. Fails soft: if the system will not raise it,
//   the tab is still the active one when the user switches to it.
import { execFileSync } from "node:child_process";
import { browser, findPage } from "./attach.mjs";
import { connect } from "./cdp.mjs";

const [match, portArg] = process.argv.slice(2);
if (!match) {
  console.error("usage: node tools/cdp/raise.mjs <url-substring> [port]");
  process.exit(1);
}
const port = Number(portArg || 9333);
const tab = await findPage(match, port);
if (!tab) {
  console.error(`no open tab matches "${match}" on port ${port}`);
  process.exit(1);
}
const b = await browser(port);
try {
  const { windowId } = await b.send("Browser.getWindowForTarget", { targetId: tab.id });
  await b.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
} catch {}
await b.send("Target.activateTarget", { targetId: tab.id }).catch(() => {});
b.close();
const page = await connect(tab.webSocketDebuggerUrl);
await page.send("Page.bringToFront").catch(() => {});
page.close();

if (process.platform === "darwin") {
  try {
    const pid = execFileSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0];
    execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], { stdio: "ignore" });
  } catch {}
}
console.log(`the Proto window is in front on ${tab.url.slice(0, 60)}`);
