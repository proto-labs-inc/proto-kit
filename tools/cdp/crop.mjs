// Crop an element from the live page at 2x, for a skipped component's
// card (MAA-164): the product itself stands in where a replica could
// not be built. Reads the tab in the visible Proto window; never
// navigates it.
//
// Usage: node tools/cdp/crop.mjs <live-tab-url> <x,y,w,h> <out.png> [port]
//   <rect> in CSS px of the live viewport. The capture is 2x whatever
//   the display's ratio is, so cards look the same on every laptop.
import { findPage } from "./attach.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./capture.mjs";
import { connect } from "./cdp.mjs";

const [match, rectArg, out, portArg] = process.argv.slice(2);
const rect = (rectArg ?? "").split(",").map(Number);
if (!match || !out || rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) {
  console.error("usage: node tools/cdp/crop.mjs <live-tab-url> <x,y,w,h> <out.png> [port]");
  process.exit(1);
}
const port = Number(portArg || 9333);
const tab = await findPage(match, port);
if (!tab) {
  console.error(`no open tab matches "${match}" on port ${port}`);
  process.exit(1);
}
const page = await connect(tab.webSocketDebuggerUrl);
const [x, y, width, height] = rect;
const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`;
await stableShot(page, probe, out, { x, y, width, height, scale: 2 });
page.close();
console.log(`${out}: ${width * 2}x${height * 2} device px from ${tab.url.slice(0, 60)}`);
