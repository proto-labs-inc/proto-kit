#!/usr/bin/env node
import { browserArguments } from "./cdp/session-context.mjs";
/** Capture conservative live-source evidence; never infer absence from one viewport. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { findPage } from "./cdp/attach.mjs";
import { widthsFor } from "./screen-verification.mjs";

export function queryKey(query) {
  return JSON.stringify([query.source, query.name || "", query.condition, query.selectors]);
}

// Executed in the live document, including open shadow roots. Dynamic pseudo
// selectors and nesting cannot prove absence and deliberately remain unknown.
export function observeContainerRules(queries) {
  const roots = [];
  function visit(root) {
    roots.push(root);
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  }
  visit(document);
  return queries.map(query => {
    let matches = 0;
    let status = "absent";
    if (!query.selectors?.length) status = "unknown";
    for (const selector of query.selectors || []) {
      let escaped = false;
      for (const char of selector) {
        if (escaped) { escaped = false; continue; }
        if (char === "\\") { escaped = true; continue; }
        if (char === ":" || char === "&") status = "unknown";
      }
      try {
        for (const root of roots) matches += root.querySelectorAll(selector).length;
      } catch { status = "unknown"; }
    }
    if (matches > 0) status = "matched";
    return { key: JSON.stringify([query.source, query.name || "", query.condition, query.selectors]), status, matches };
  });
}

export async function captureContainerObservation(page, css, state) {
  if (!state?.trim()) throw new Error("Name the inspected source state.");
  const observation = await evaluate(page, `({sourceUrl:location.href,width:innerWidth,queries:(${observeContainerRules.toString()})(${JSON.stringify(css.containerQueries || [])})})`);
  if (observation.sourceUrl !== css.sourceUrl) throw new Error("Select the exact source URL from the CSS report.");
  return { ...observation, state, capturedAt: new Date().toISOString() };
}

export function hasCompleteAbsenceEvidence(plan, query) {
  const states = plan.inventory?.states?.filter(state => state.kind === "source").map(state => state.id);
  if (!Array.isArray(states) || !states.length || !query.source || !query.selectors?.length) return false;
  const observations = plan.containerObservations;
  if (!Array.isArray(observations)) return false;
  const key = queryKey(query);
  const relevant = observations.filter(o => o.sourceUrl === plan.inventory.sourceUrl);
  // A contradictory observation must not be hidden by a later absent sample.
  if (relevant.some(o => o.queries?.some(q => q.key === key && (q.status !== "absent" || q.matches !== 0)))) return false;
  return states.every(state => widthsFor(plan.inventory).every(width => relevant.some(o =>
    o.state === state && o.width === width && Number.isFinite(Date.parse(o.capturedAt)) &&
    Date.parse(o.capturedAt) >= Date.parse(plan.responsiveCss.capturedAt) &&
    o.queries?.some(q => q.key === key && q.status === "absent" && q.matches === 0)
  )));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, cssFile, state, output, port = "9333"] = browserArguments();
  if (!url || !cssFile || !state || !output) throw new Error("usage: container-applicability.mjs <exact-live-url> <responsive-css.json> <state> <observations.json> [cdp-port]");
  const css = JSON.parse(readFileSync(cssFile, "utf8"));
  const tab = await findPage(url, Number(port));
  if (!tab) throw new Error("Source not found; supply --browser-session");
  const page = await connect(tab.webSocketDebuggerUrl);
  try {
    const observation = await captureContainerObservation(page, css, state);
    const observations = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : [];
    observations.push(observation);
    writeFileSync(output, JSON.stringify(observations, null, 2) + "\n");
    console.log(JSON.stringify(observation));
  } finally { page.close(); }
}
