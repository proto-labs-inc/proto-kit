// The rendered height of a standalone state file, measured in the
// headless Chrome after its fonts load: the `height` a state entry in
// the manifest carries (docs/library-contract.md). Never guessed.
//
// Usage: node tools/cdp/measure.mjs <state.html> [width]
//   Prints the height in CSS px. width defaults to 1200, the width
//   the library frames states at on a laptop.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluate } from "./cdp.mjs";
import { headlessPage } from "./headless.mjs";

const [fileArg, widthArg] = process.argv.slice(2);
if (!fileArg || !existsSync(fileArg)) {
  console.error("usage: node tools/cdp/measure.mjs <state.html> [width]");
  process.exit(1);
}
const width = Number(widthArg || 1200);
const page = await headlessPage(pathToFileURL(resolve(fileArg)).href, { width, height: 400, dpr: 1 });
// The content's own extent, not the viewport's: the html box, or the
// body's bottom edge plus its margin when the body is taller.
const height = await evaluate(
  page.page,
  `Math.ceil(Math.max(
    document.documentElement.getBoundingClientRect().height,
    document.body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(document.body).marginBottom)
  ))`,
);
await page.close();
console.log(height);
