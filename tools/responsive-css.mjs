#!/usr/bin/env node
/** Read the live browser's compiled styles, independent of its CSS authoring framework. */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { listPages } from "./cdp/attach.mjs";
import { widthsFor } from "./screen-verification.mjs";

export function mediaBreakpoints(medias, initialFontSize) {
  const breakpoints = new Set();
  const unresolved = [];
  for (const media of medias) {
    if (/^\s*(only\s+)?print\b/.test(media.text) && !/,/.test(media.text)) continue;
    let found = false;
    for (const query of media.mediaList || []) {
      for (const expression of query.expressions || []) {
        if (!/^(min-|max-)?width$/.test(expression.feature)) continue;
        found = true;
        // Chrome resolves em/rem against the browser's initial font size for
        // media queries, which may differ from the product's root font size.
        let pixels = expression.computedLength;
        if (expression.unit === "px") pixels = expression.value;
        if (["em", "rem"].includes(expression.unit) && Number.isFinite(initialFontSize))
          pixels = expression.value * initialFontSize;
        if (Number.isFinite(pixels) && pixels >= 2 && pixels <= 9999) breakpoints.add(pixels);
        else unresolved.push(media.text);
      }
    }
    if (!found && /\bwidth\b/.test(media.text)) unresolved.push(media.text);
    if (/\b(height|orientation|aspect-ratio)\b/.test(media.text)) unresolved.push(media.text);
  }
  return { breakpoints: [...breakpoints].sort((a, b) => a - b), unresolved: [...new Set(unresolved)] };
}

/** Executed in the page. CSSOM parses nested/layered rules and constructed sheets. */
export function containerRules(texts) {
  const queries = [];
  const warnings = [];
  const visited = new Set();
  const selectorsIn = (rules) => {
    const selectors = [];
    for (const rule of rules) {
      if (rule.selectorText) selectors.push(rule.selectorText);
      if (rule.cssRules) selectors.push(...selectorsIn(rule.cssRules));
    }
    return selectors;
  };
  const walk = (rules, source) => {
    for (const rule of rules) {
      if (rule.constructor.name === "CSSContainerRule") {
        queries.push({ name: rule.containerName || "", condition: rule.conditionText,
          source, selectors: selectorsIn(rule.cssRules) });
      }
      if (rule.styleSheet) sheet(rule.styleSheet, source);
      if (rule.cssRules) walk(rule.cssRules, source);
    }
  };
  const sheet = (styleSheet, source) => {
    if (visited.has(styleSheet)) return;
    visited.add(styleSheet);
    try { walk(styleSheet.cssRules, styleSheet.href || source); }
    catch { warnings.push(`CSSOM access denied: ${styleSheet.href || source}`); }
  };
  const root = (node) => {
    for (const styleSheet of [...(node.styleSheets || []), ...(node.adoptedStyleSheets || [])]) sheet(styleSheet, "inline/adopted");
    for (const element of node.querySelectorAll("*")) if (element.shadowRoot) root(element.shadowRoot);
  };
  if (!texts.length) root(document);
  // CDP supplies cross-origin sheets that the page's CSSOM cannot read.
  for (const { source, text } of texts) {
    try {
      const parsed = new CSSStyleSheet();
      parsed.replaceSync(text);
      walk(parsed.cssRules, source);
    } catch { warnings.push(`Could not parse stylesheet: ${source}`); }
  }
  const unique = new Map(queries.map(query => [JSON.stringify([query.name, query.condition, query.selectors]), query]));
  return { containerQueries: [...unique.values()], warnings };
}

export async function discoverResponsiveCss(page) {
  const sheets = new Map();
  const off = page.on("CSS.styleSheetAdded", ({ header }) => sheets.set(header.styleSheetId, header));
  try {
    await page.send("DOM.enable");
    await page.send("CSS.enable");
    const { medias } = await page.send("CSS.getMediaQueries");
    const initialFontSize = await evaluate(page, `(()=>{const probe=document.createElement('span');probe.style.cssText='position:fixed;visibility:hidden;font-size:initial!important';document.documentElement.append(probe);const size=parseFloat(getComputedStyle(probe).fontSize);probe.remove();return size})()`);
    const result = mediaBreakpoints(medias, initialFontSize);
    const texts = [];
    const warnings = [];
    for (const [styleSheetId, header] of sheets) {
      try {
        const { text } = await page.send("CSS.getStyleSheetText", { styleSheetId });
        texts.push({ source: header.sourceURL || `inline:${styleSheetId}`, text });
      } catch { warnings.push(`Could not read stylesheet: ${header.sourceURL || styleSheetId}`); }
    }
    // Parse one sheet per call to keep protocol payloads bounded. The first
    // pass also covers adopted sheets and open shadow roots.
    const base = await evaluate(page, `(${containerRules.toString()})([])`);
    const containers = [...base.containerQueries];
    for (const text of texts) {
      const parsed = await evaluate(page, `(${containerRules.toString()})(${JSON.stringify([text])})`);
      containers.push(...parsed.containerQueries);
      warnings.push(...parsed.warnings.filter(warning => !warning.startsWith("CSSOM access denied:")));
    }
    // A denied CSSOM sheet is covered only when CDP actually read that URL.
    for (const warning of base.warnings) {
      const url = warning.replace("CSSOM access denied: ", "");
      if (!texts.some(text => text.source === url)) warnings.push(warning);
    }
    const unique = new Map(containers.map(query => [JSON.stringify([query.name, query.condition, query.selectors]), query]));
    const sourceUrl = await evaluate(page, "location.href");
    return { sourceUrl, capturedAt: new Date().toISOString(), ...result,
      widths: widthsFor(result), containerQueries: [...unique.values()], warnings: [...new Set(warnings)] };
  } finally { off(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, output, port = "9333"] = process.argv.slice(2);
  if (!url || !output) throw new Error("usage: responsive-css.mjs <exact-live-url> <output.json> [cdp-port]");
  const tabs = await listPages(Number(port));
  const matches = tabs.filter(tab => tab.url === url);
  if (matches.length !== 1) throw new Error("Expected one existing tab at the exact live URL; select the source tab explicitly.");
  const page = await connect(matches[0].webSocketDebuggerUrl);
  try {
    const report = await discoverResponsiveCss(page);
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { page.close(); }
}
