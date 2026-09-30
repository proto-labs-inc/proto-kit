#!/usr/bin/env node
// Prepare the product page in the dedicated Proto Chrome window.
import { findOrOpenPage } from "./attach.mjs";

const url = process.argv[2];
if (!url) {
  console.error("usage: node tools/cdp/product-page.mjs <product-url>");
  process.exit(1);
}

try {
  const result = await findOrOpenPage(url);
  console.log(JSON.stringify({
    url: result.tab.url,
    targetId: result.tab.id,
    action: result.created ? "opened" : result.navigated ? "navigated blank tab" : "reused",
  }));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
