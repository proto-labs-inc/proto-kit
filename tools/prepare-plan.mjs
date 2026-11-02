#!/usr/bin/env node
/**
 * One command for a starter screen's verification evidence, so agents never
 * write their own capture, inventory, plan or local-check scripts.
 *
 *   prepare-plan.mjs capture <exact-live-url> <plan-dir> --browser-session <path>
 *       [--states states.json] [--breakpoints 900,1100.5] [--height 900]
 *       [--capture '{"reducedMotion":"reduce"}'] [--concurrency 3]
 *     Reads the signed-in source window: compiled responsive CSS (again after
 *     opening each state), container observations for every state and width,
 *     the control inventory, and every reference PNG. Writes plan-dir/plan.json:
 *     a complete, schema-valid skeleton whose only TODOs are control outcomes
 *     (and container-query layouts, when the page has live container rules).
 *     Re-running keeps every assertion already filled in.
 *   prepare-plan.mjs lint <plan.json>
 *     Lists everything that would make verification refuse or fail the plan.
 *   prepare-plan.mjs run <workspace-or-dist> <plan.json> [--only id,id] [--match regex]
 *       [--widths 320,1440] [--bail] [--concurrency N] [--out dir] [--no-build]
 *     Builds the workspace and runs the plan's scenarios with the same runner
 *     as `screen-index.mjs verify`, in parallel, printing only failures.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { clearScreenRender } from "./cdp/render-profile.mjs";
import { setReferenceViewport, shootReference } from "./cdp/reference.mjs";
import { discoverResponsiveCss } from "./responsive-css.mjs";
import { captureContainerObservation, hasCompleteAbsenceEvidence } from "./container-applicability.mjs";
import { widthsFor, widthsForScenario, referenceWidths, validateStateInventory } from "./screen-verification.mjs";
import { step, until, assertionProblems, validateResponsivePlan, runPlan, preflightPlan, captureProfileFor, applyCaptureMedia, verifyConcurrency } from "./verify-screen.mjs";

export const BOUNDARY_TEXT = "This screen isn’t included in this prototype";
const SOURCE_CATEGORIES = ["visual", "responsive", "state", "isolation"];
const BOUNDARY_CATEGORIES = ["responsive", "state", "isolation"];
const identity = (expression) => expression;

/** Copy-side helper: is an element whose own text or aria-label equals `text` visible? */
export const VISIBLE_TEXT = "(text=>{const n=t=>(t||'').replace(/\\s+/g,' ').trim();return [...document.querySelectorAll('body *')].some(e=>(n(e.getAttribute('aria-label'))===text||(n(e.textContent)===text&&![...e.children].some(c=>n(c.textContent)===text)))&&e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})&&e.getClientRects().length>0)})";
const OVERLAY = "[role=dialog],[role=alertdialog],[role=menu],[role=listbox],dialog[open]";
const OVERLAY_VISIBLE = `[...document.querySelectorAll(${JSON.stringify(OVERLAY)})].some(e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))`;

/** Runs in the live page. mode "snapshot": controls, visible text tokens and
 *  overlays; mode "containers": the query container of each container rule. */
export function pageProbe(mode, arg, seen) {
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  const generated = (id) => /\d{3,}|^[:_]|:|radix|headlessui|react-aria|^mui-|^rc[-_]/i.test(id);
  const quote = (value) => JSON.stringify(value);
  const selectorFor = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id && !generated(element.id) && unique("#" + CSS.escape(element.id))) return { selector: "#" + CSS.escape(element.id), stable: true };
    for (const name of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label"]) {
      const value = element.getAttribute(name);
      if (value && unique(`${tag}[${name}=${quote(value)}]`)) return { selector: `${tag}[${name}=${quote(value)}]`, stable: true };
    }
    if (tag === "a" && element.getAttribute("href") && unique(`a[href=${quote(element.getAttribute("href"))}]`))
      return { selector: `a[href=${quote(element.getAttribute("href"))}]`, stable: true };
    const parts = [];
    let node = element;
    for (; node && node !== document.body && node.parentElement; node = node.parentElement) {
      if (node !== element && node.id && !generated(node.id) && unique("#" + CSS.escape(node.id))) { parts.unshift("#" + CSS.escape(node.id)); break; }
      const name = node.tagName.toLowerCase();
      const siblings = [...node.parentElement.children].filter(child => child.tagName === node.tagName);
      parts.unshift(siblings.length > 1 ? `${name}:nth-of-type(${siblings.indexOf(node) + 1})` : name);
    }
    if (node === document.body) parts.unshift("body");
    return { selector: parts.join(" > "), stable: false };
  };
  if (mode === "containers") {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return arg.map(query => {
      const names = (query.name || "").split(/\s+/).filter(Boolean);
      for (const selector of query.selectors || []) {
        let elements = [];
        try { elements = document.querySelectorAll(selector); } catch { continue; }
        for (const element of elements)
          for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (!style.containerType || style.containerType === "normal") continue;
            if (names.length && !names.some(name => style.containerName.split(/\s+/).includes(name))) continue;
            return { ...selectorFor(ancestor), fontSize: parseFloat(style.fontSize), rootFontSize: root, width: ancestor.getBoundingClientRect().width };
          }
      }
      return null;
    });
  }
  const visible = (element) => element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && element.getClientRects().length > 0
    && (rect => rect.width > 0 && rect.height > 0)(element.getBoundingClientRect());
  const CONTROLS = 'button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=switch],[role=checkbox],[role=radio],[role=combobox],[role=option],[contenteditable=""],[contenteditable=true]';
  const labelOf = (element) => {
    const aria = clean(element.getAttribute("aria-label"));
    if (aria) return { label: aria, textual: true };
    const text = clean(element.textContent);
    if (text && text.length <= 80 && !["input", "select", "textarea"].includes(element.tagName.toLowerCase())) return { label: text, textual: true };
    const by = element.getAttribute("aria-labelledby");
    const labelled = by && clean(by.split(/\s+/).map(id => document.getElementById(id)?.textContent || "").join(" "));
    const own = element.labels?.length ? clean([...element.labels].map(label => label.textContent).join(" ")) : "";
    const fallback = labelled || own || clean(element.getAttribute("placeholder")) || clean(element.getAttribute("title"))
      || clean(element.querySelector("img[alt]")?.alt) || clean(element.getAttribute("name")) || text.slice(0, 80);
    return { label: fallback, textual: Boolean(labelled || own) && fallback.length <= 80 };
  };
  const controls = [];
  const candidates = new Set();
  for (const element of document.querySelectorAll(CONTROLS)) {
    if (element.closest('[inert],[aria-hidden="true"]')) continue;
    const { label, textual } = labelOf(element);
    if (textual && label) candidates.add(label);
    if (!visible(element)) continue;
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || "";
    const href = tag === "a" ? element.getAttribute("href") : null;
    controls.push({
      tag, role, type: (element.getAttribute("type") || "").toLowerCase(), label, href,
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
      haspopup: element.getAttribute("aria-haspopup"), expanded: element.getAttribute("aria-expanded"),
      ...selectorFor(element), key: [tag, role, label, href].join("|"),
    });
  }
  const headings = [];
  for (const element of document.querySelectorAll("h1,h2,h3,[role=heading]")) {
    const text = clean(element.textContent);
    if (text && text.length <= 80) { candidates.add(text); headings.push(text); }
  }
  const tokens = [...candidates].slice(0, 600).filter(text => seen(text));
  const overlays = [...document.querySelectorAll(arg)].filter(visible).length;
  return JSON.stringify({ url: location.href, width: innerWidth, controls, tokens, headings: headings.filter(text => tokens.includes(text)), overlays });
}

async function snapshot(page) {
  return JSON.parse(await evaluate(page, `(${pageProbe.toString()})("snapshot", ${JSON.stringify(OVERLAY)}, ${VISIBLE_TEXT})`));
}

// ---------------------------------------------------------------------------
// Plan skeleton (pure)

const slug = (text) => (text || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Merge per-state, per-width control snapshots into logical controls. */
export function mergeControls(snapshots, states) {
  const merged = new Map();
  for (const state of states)
    for (const [width, shot] of Object.entries(snapshots[state.id] || {})) {
      const occurrences = new Map();
      for (const control of shot.controls || []) {
        const count = (occurrences.get(control.key) || 0) + 1;
        occurrences.set(control.key, count);
        const key = count > 1 ? `${control.key}#${count}` : control.key;
        let entry = merged.get(key);
        if (!entry) merged.set(key, entry = { ...control, key, visible: {} });
        if (!entry.stable && control.stable) Object.assign(entry, { selector: control.selector, stable: true });
        entry.disabled = entry.disabled || control.disabled;
        (entry.visible[state.id] ||= []).push(Number(width));
      }
    }
  const used = new Set();
  return [...merged.values()].map(entry => {
    const kind = entry.role || (entry.tag === "a" ? "link" : entry.tag);
    let id = slug(`${kind}-${entry.label || entry.type || "unlabelled"}`) || "control";
    for (let n = 2; used.has(id); n++) id = `${slug(`${kind}-${entry.label || entry.type || "unlabelled"}`)}-${n}`;
    used.add(id);
    for (const widths of Object.values(entry.visible)) widths.sort((a, b) => a - b);
    return { ...entry, id };
  });
}

function hintFor(control, states, allWidths) {
  const hints = [];
  if (control.href) {
    if (control.href.startsWith("#")) hints.push(`scrolls to ${control.href}`);
    else hints.push(`links to ${control.href}: copy the destination, or declare a prototype-boundary state for it`);
  }
  if (control.haspopup || control.expanded !== null && control.expanded !== undefined)
    hints.push(`toggles a ${control.haspopup && control.haspopup !== "true" ? control.haspopup : "popup"}: assert it opens and aria-expanded`);
  if (["input", "textarea"].includes(control.tag) || control.role === "combobox") hints.push("assert the typed value or validation message");
  if (["checkbox", "radio", "switch"].includes(control.role) || ["checkbox", "radio"].includes(control.type)) hints.push("assert the checked state");
  const [state, widths] = bestState(control, states);
  if (widths.length !== allWidths.length)
    hints.push(`visible in state ${state} only at ${widths.join(",")}px; make the scenario reach it at every width`);
  return hints.join("; ") || "assert its visible outcome";
}

function bestState(control, states) {
  let best = [states[0].id, []];
  for (const state of states) {
    const widths = control.visible[state.id] || [];
    if (widths.length > best[1].length) best = [state.id, widths];
  }
  return best;
}

const seenExpression = (terms) => `(seen=>${terms.join("&&")})(${VISIBLE_TEXT})`;
const seen = (text) => `seen(${JSON.stringify(text)})`;

function tokenWidths(snapshots, stateId) {
  const result = new Map();
  for (const [width, shot] of Object.entries(snapshots[stateId] || {}))
    for (const token of shot.tokens || []) {
      if (!result.has(token)) result.set(token, new Set());
      result.get(token).add(Number(width));
    }
  return result;
}

/** What identifies a state at every width, derived from the live source. */
export function stateTerms(snapshots, state, defaultId) {
  const shots = Object.values(snapshots[state.id] || {});
  if (!shots.length) return null;
  const widths = shots.length;
  const tokens = tokenWidths(snapshots, state.id);
  const always = [...tokens].filter(([, set]) => set.size === widths).map(([token]) => token);
  const headings = new Set(shots.flatMap(shot => shot.headings || []));
  const overlayAlways = shots.every(shot => shot.overlays > 0);
  const overlayNever = shots.every(shot => !shot.overlays);
  if (state.id === defaultId) {
    const pick = always.find(token => headings.has(token)) ?? always.find(token => token.length <= 40);
    if (!pick) return null;
    return [seen(pick), ...(overlayNever ? [`!${OVERLAY_VISIBLE}`] : [])];
  }
  const base = tokenWidths(snapshots, defaultId);
  const distinct = always.filter(token => !base.has(token)).sort((a, b) => Number(headings.has(b)) - Number(headings.has(a)) || a.length - b.length);
  const terms = distinct.slice(0, 2).map(seen);
  const defaultOverlay = Object.values(snapshots[defaultId] || {}).some(shot => shot.overlays > 0);
  if (overlayAlways && !defaultOverlay) terms.push(OVERLAY_VISIBLE);
  return terms.length ? terms : null;
}

/** Width-dependent visibility observed in the source, as assertion terms. */
export function responsiveTerms(snapshots, stateId) {
  const widths = Object.keys(snapshots[stateId] || {}).map(Number).sort((a, b) => a - b);
  if (widths.length < 2) return [];
  const byThreshold = new Map();
  for (const [token, set] of tokenWidths(snapshots, stateId)) {
    const vector = widths.map(width => set.has(width));
    const changes = vector.slice(1).filter((value, index) => value !== vector[index]).length;
    if (changes !== 1 || token.length > 40) continue;
    const at = vector.findIndex((value, index) => index > 0 && value !== vector[index - 1]);
    const threshold = widths[at];
    const term = `${seen(token)}===(innerWidth${vector[at] ? ">=" : "<"}${threshold})`;
    if (!byThreshold.has(threshold) || token.length < byThreshold.get(threshold).token.length) byThreshold.set(threshold, { token, term });
  }
  return [...byThreshold.values()].slice(0, 4).map(entry => entry.term);
}

const todo = (text) => `TODO: ${text}`;

export function containerThreshold(condition, { fontSize = 16, rootFontSize = 16 } = {}) {
  if (!/(width|inline-size)/.test(condition)) return null;
  const match = /([\d.]+)\s*(px|em|rem)/.exec(condition);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (match[2] === "px") return value;
  return value * (match[2] === "em" ? fontSize : rootFontSize);
}

export function containerSteps(selector, threshold) {
  const below = Math.floor(threshold) - 1;
  const above = Math.ceil(threshold) + 1;
  const assertAt = (size) => ({ kind: "assert", expression: todo(`layout with the container at ${size}px`) });
  return [
    { kind: "resize-container", selector, width: below }, assertAt(below),
    { kind: "resize-container", selector, width: threshold }, assertAt(threshold),
    { kind: "resize-container", selector, width: above },
  ];
}

/**
 * Build the verification plan from captured evidence. Everything the source
 * determines is filled in; what only the agent can know is a "TODO: …" string
 * that lint and verification refuse.
 */
export function planSkeleton({ css, states, snapshots, observations = [], references = {}, containers = [], height = 900, capture, extraBreakpoints = [], extraControls = [], capturedAt = new Date().toISOString() }) {
  const sourceStates = states.filter(state => state.kind !== "prototype-boundary");
  const defaultId = sourceStates[0].id;
  const breakpoints = [...new Set([...css.breakpoints, ...extraBreakpoints])].sort((a, b) => a - b);
  const inventoryStates = states.map(state => state.kind === "prototype-boundary"
    ? { id: state.id, kind: state.kind, originatingControl: state.originatingControl, destination: state.destination, returnControl: state.returnControl, returnState: state.returnState }
    : { id: state.id, kind: "source" });
  const inventory = { sourceUrl: css.sourceUrl, capturedAt, controls: [], states: inventoryStates, breakpoints };
  const widths = widthsFor(inventory);
  const merged = mergeControls(snapshots, sourceStates);
  const scenarios = [];
  const notes = { tagInCopy: [], partialWidth: [], statesWithoutAutoAssertion: [], responsiveWithoutWidthTerms: [] };
  const pathOf = (stateId) => states.find(state => state.id === stateId)?.path ?? (stateId === defaultId ? "/" : `/?state=${encodeURIComponent(stateId)}`);

  for (const control of merged) {
    const [stateId, visibleWidths] = bestState(control, sourceStates);
    const selector = control.stable ? control.selector : `[data-proto-id=${JSON.stringify(control.id)}]`;
    if (!control.stable) notes.tagInCopy.push({ id: control.id, sourceSelector: control.selector });
    if (visibleWidths.length !== widths.length) notes.partialWidth.push({ id: control.id, state: stateId, widths: visibleWidths });
    const path = pathOf(stateId);
    const text = ["input", "textarea"].includes(control.tag) && !["checkbox", "radio", "button", "submit", "reset"].includes(control.type) || control.role === "combobox";
    const toggle = ["checkbox", "radio", "switch"].includes(control.role) || ["checkbox", "radio"].includes(control.type);
    let pointer = [{ kind: "click", selector }];
    let keyboard = [{ kind: "key", key: "Tab", until: selector }, { kind: "key", key: toggle ? " " : "Enter" }];
    if (text) {
      pointer = [...pointer, { kind: "type", text: "sample" }];
      keyboard = [keyboard[0], { kind: "type", text: "sample" }];
    } else if (control.tag === "select") keyboard = [keyboard[0], { kind: "key", key: "ArrowDown" }];
    let expected = todo(hintFor(control, sourceStates, widths));
    let pointerAssertion = expected;
    let keyboardAssertion = expected;
    if (control.disabled) {
      const element = `document.querySelector(${JSON.stringify(selector)})`;
      const unchanged = `location.pathname+location.search===${JSON.stringify(path.split("#")[0])}`;
      expected = "Disabled; activating it changes nothing.";
      pointerAssertion = `(e=>!!e&&(e.disabled||e.getAttribute('aria-disabled')==='true'))(${element})&&${unchanged}`;
      keyboard = [{ kind: "key", key: "Tab" }];
      keyboardAssertion = `(e=>!!e&&(e.disabled||e.getAttribute('aria-disabled')==='true')&&document.activeElement!==e)(${element})&&${unchanged}`;
    }
    inventory.controls.push({ id: control.id, expected, state: control.disabled ? "disabled" : "enabled" });
    scenarios.push({ id: `pointer-${control.id}`, category: "interaction", target: control.id, path, steps: pointer, assertion: pointerAssertion });
    scenarios.push({ id: `keyboard-${control.id}`, category: "keyboard", target: control.id, path, steps: keyboard, assertion: keyboardAssertion });
  }
  for (const control of extraControls) {
    if (!control.id || !control.selector) throw new Error("Extra controls need an id and a selector");
    const path = control.path ?? "/";
    inventory.controls.push({ id: control.id, expected: control.expected ?? todo("describe its outcome"), state: control.state ?? "enabled" });
    scenarios.push({ id: `pointer-${control.id}`, category: "interaction", target: control.id, path, steps: [{ kind: "click", selector: control.selector }], assertion: control.assertion ?? todo("assert its visible outcome") });
    scenarios.push({ id: `keyboard-${control.id}`, category: "keyboard", target: control.id, path, steps: [{ kind: "key", key: "Tab", until: control.selector }, { kind: "key", key: "Enter" }], assertion: control.assertion ?? todo("assert its visible outcome") });
  }

  for (const state of states) {
    const path = pathOf(state.id);
    if (state.kind === "prototype-boundary") {
      const assertion = `(seen=>seen(${JSON.stringify(BOUNDARY_TEXT)}))(${VISIBLE_TEXT})`;
      for (const category of BOUNDARY_CATEGORIES)
        scenarios.push({ id: `${category}-${state.id}`, category, target: state.id, path, steps: [], assertion });
      continue;
    }
    const terms = stateTerms(snapshots, state, defaultId);
    if (!terms) notes.statesWithoutAutoAssertion.push(state.id);
    const assertion = terms ? seenExpression(terms) : todo(`assert what identifies state ${state.id}`);
    const refs = references[state.id] || {};
    const widthTerms = responsiveTerms(snapshots, state.id);
    let responsive = assertion;
    if (terms && widthTerms.length) responsive = seenExpression([...terms, ...widthTerms]);
    else if (terms) {
      notes.responsiveWithoutWidthTerms.push(state.id);
      responsive = `/* auto: no width-dependent visibility observed; layout is compared with the references */ ${seenExpression([...terms, "document.documentElement.scrollWidth<=innerWidth+1"])}`;
    }
    scenarios.push({ id: `visual-${state.id}`, category: "visual", target: state.id, path, steps: [], assertion, references: refs });
    scenarios.push({ id: `responsive-${state.id}`, category: "responsive", target: state.id, path, steps: [], assertion: responsive, references: refs });
    scenarios.push({ id: `state-${state.id}`, category: "state", target: state.id, path, steps: [], assertion });
    scenarios.push({ id: `isolation-${state.id}`, category: "isolation", target: state.id, path, steps: [], assertion });
  }

  const plan = { inventory, responsiveCss: css, height, scenarios, containerObservations: observations };
  if (capture && Object.keys(capture).length) plan.capture = capture;
  const review = {};
  for (const finding of [...(css.warnings || []), ...(css.unresolved || [])]) review[finding] = todo("inspect this CSS in the source and record the behaviour and how the plan covers it");
  if (Object.keys(review).length) plan.responsiveCssReview = review;
  containers.forEach((entry, index) => {
    if (hasCompleteAbsenceEvidence(plan, entry.query)) return;
    const selector = entry.selector ?? todo(`selector of the query container for ${entry.query.condition}`);
    const threshold = entry.threshold;
    scenarios.push({
      id: `container-${index + 1}-${defaultId}`, category: "responsive", target: defaultId, path: pathOf(defaultId),
      containerQuery: entry.query.condition,
      steps: threshold ? containerSteps(selector, threshold) : [{ kind: "resize-container", selector, width: 0 }, { kind: "assert", expression: todo(`threshold sizes for ${entry.query.condition}`) }],
      assertion: todo(`layout with the container above ${entry.query.condition}`),
      references: entry.references || {},
    });
  });
  return { plan, notes };
}

/** Keep everything the agent already completed when capture runs again. */
export function mergePlan(existing, fresh) {
  if (!existing) return fresh;
  const done = (value) => value !== undefined && !JSON.stringify(value).includes("TODO");
  const oldControls = new Map((existing.inventory?.controls || []).map(control => [control.id, control]));
  for (const control of fresh.inventory.controls) {
    const old = oldControls.get(control.id);
    if (old && done(old.expected)) control.expected = old.expected;
  }
  const oldScenarios = new Map((existing.scenarios || []).map(scenario => [scenario.id, scenario]));
  fresh.scenarios = fresh.scenarios.map(scenario => {
    const old = oldScenarios.get(scenario.id);
    if (!old) return scenario;
    const keep = {};
    for (const key of ["path", "steps", "assertion", "containerQuery", "capture"])
      if (done(old[key])) keep[key] = old[key];
    return { ...scenario, ...keep };
  });
  const freshIds = new Set(fresh.scenarios.map(scenario => scenario.id));
  const targets = new Set([...fresh.inventory.controls.map(c => c.id), ...fresh.inventory.states.map(s => s.id)]);
  for (const scenario of existing.scenarios || [])
    if (!freshIds.has(scenario.id) && targets.has(scenario.target)) fresh.scenarios.push(scenario);
  for (const [finding, review] of Object.entries(existing.responsiveCssReview || {}))
    if (fresh.responsiveCssReview?.[finding] !== undefined && done(review)) fresh.responsiveCssReview[finding] = review;
  return fresh;
}

/** Everything that would make verification refuse or fail this plan before it runs. */
export function lintPlan(plan, { files = true } = {}) {
  const problems = [];
  const attempt = (check) => { try { check(); } catch (error) { problems.push(error.message); } };
  attempt(() => validateStateInventory(plan.inventory));
  attempt(() => validateResponsivePlan(plan));
  problems.push(...assertionProblems(plan));
  attempt(() => { captureProfileFor(plan); for (const scenario of plan.scenarios || []) captureProfileFor(plan, scenario); });
  const inventory = plan.inventory || {};
  for (const control of inventory.controls || [])
    if (!control.expected || !["enabled", "disabled"].includes(control.state)) problems.push(`Control ${control.id} needs expected and enabled/disabled state`);
  const ids = (plan.scenarios || []).map(scenario => scenario.id);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) problems.push(`Duplicate scenario id ${id}`);
  for (const ids of [(inventory.controls || []).map(c => c.id), (inventory.states || []).map(s => s.id)])
    for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) problems.push(`Duplicate inventory id ${id}`);
  const has = (category, target) => (plan.scenarios || []).some(scenario => scenario.category === category && scenario.target === target);
  for (const state of inventory.states || [])
    for (const category of state.kind === "source" ? SOURCE_CATEGORIES : BOUNDARY_CATEGORIES)
      if (!has(category, state.id)) problems.push(`Missing ${category} scenario for state ${state.id}`);
  for (const control of inventory.controls || [])
    for (const category of ["interaction", "keyboard"])
      if (!has(category, control.id)) problems.push(`Missing ${category} scenario for control ${control.id}`);
  for (const scenario of plan.scenarios || []) {
    const controlScenario = ["interaction", "keyboard"].includes(scenario.category);
    const known = controlScenario ? (inventory.controls || []).some(c => c.id === scenario.target) : (inventory.states || []).some(s => s.id === scenario.target);
    if (!known) problems.push(`Scenario ${scenario.id} targets unknown ${controlScenario ? "control" : "state"} ${scenario.target}`);
    if (typeof scenario.path === "string" && (!scenario.path.startsWith("/") || scenario.path.startsWith("//"))) problems.push(`Scenario ${scenario.id} needs a local path`);
    const state = (inventory.states || []).find(s => s.id === scenario.target);
    if (!["visual", "responsive"].includes(scenario.category) || state?.kind !== "source") continue;
    let widths = [];
    try { widths = Array.isArray(inventory.breakpoints) ? widthsForScenario(inventory, scenario) : []; } catch {}
    const missing = widths.filter(width => !scenario.references?.[width] || (files && !existsSync(scenario.references[width])));
    if (missing.length) problems.push(`Scenario ${scenario.id} lacks reference PNGs at ${missing.join(",")}px`);
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------
// Live source capture

async function settle(page) {
  await evaluate(page, "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
  await until(page, "document.getAnimations().every(a => !Number.isFinite(a.effect?.getComputedTiming().endTime) || a.playState !== 'running')").catch(() => {});
  await until(page, "Array.from(document.images).every(i=>{const r=i.getBoundingClientRect();return !(i.checkVisibility()&&r.bottom>0&&r.top<innerHeight)||i.complete})").catch(() => {});
}

/** The source tab at the screen render (tools/cdp/render-profile.mjs, the
 *  same as reference.mjs and the verifier): exact CSS viewport, 1x, sRGB, no
 *  scrollbars, focused. */
async function resizeTo(page, width, height) {
  await setReferenceViewport(page, width, height);
  await settle(page);
}

async function navigate(page, url) {
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error(`Source did not load within 30 s: ${url}`)), 30_000).unref())]);
  await until(page, "document.readyState === 'complete'");
  await settle(page);
}

const shoot = (page, file, capture) => shootReference(page, file, capture ?? {});

async function preparePage(page, capture) {
  await page.send("Page.enable");
  if (capture) await applyCaptureMedia(page, capture);
}

/**
 * Capture every piece of source evidence and write plan-dir/plan.json.
 * `openLane()` returns { page, close } for an extra page in the signed-in
 * browser (parallel captures), or null to stay sequential.
 */
/** Captures the plan; the source window always gets its own rendering back, even when capture fails. */
export async function capturePlan(options) {
  try {
    return await captureSourcePlan(options);
  } finally {
    await clearScreenRender(options.page).catch(() => {});
  }
}

async function captureSourcePlan({ page, url, dir, states: stateSpec = {}, height = 900, capture, extraBreakpoints = [], lanes = 1, openLane, log = () => {} }) {
  const started = Date.now();
  mkdirSync(join(dir, "references"), { recursive: true });
  const states = normalizeStates(stateSpec.states ?? stateSpec);
  const sourceStates = states.filter(state => state.kind !== "prototype-boundary");
  const problems = [];
  capture = capture ? captureProfileFor({ capture }) : undefined;
  await preparePage(page, capture);

  log("Reading compiled responsive CSS");
  const css = await discoverResponsiveCss(page);
  if (css.sourceUrl !== url) problems.push(`The source is at ${css.sourceUrl}, not ${url}; the plan uses ${css.sourceUrl}`);
  for (const state of sourceStates.slice(1)) {
    try {
      await resizeTo(page, 1440, height);
      await navigate(page, css.sourceUrl);
      for (const action of state.steps) await step(page, action, identity);
      await settle(page);
      const more = await discoverResponsiveCss(page);
      css.breakpoints = [...new Set([...css.breakpoints, ...more.breakpoints])].sort((a, b) => a - b);
      css.unresolved = [...new Set([...css.unresolved, ...more.unresolved])];
      css.warnings = [...new Set([...css.warnings, ...more.warnings])];
      const keys = new Set(css.containerQueries.map(q => JSON.stringify([q.source, q.name, q.condition, q.selectors])));
      css.containerQueries.push(...more.containerQueries.filter(q => !keys.has(JSON.stringify([q.source, q.name, q.condition, q.selectors]))));
    } catch (error) { problems.push(`State ${state.id} could not be opened in the source: ${error.message}`); }
  }
  // References only where the scoped matrix compares screenshots: the union
  // of widthsForScenario over the visual/responsive scenarios the skeleton
  // writes (container scenarios use the same layout set).
  const widths = referenceWidths({ breakpoints: [...new Set([...css.breakpoints, ...extraBreakpoints])] },
    SOURCE_CATEGORIES.map(category => ({ category })));
  css.widths = widthsFor(css);
  writeFileSync(join(dir, "responsive-css.json"), JSON.stringify(css, null, 2) + "\n");

  const snapshots = {};
  const references = {};
  const observations = [];
  const jobs = sourceStates.flatMap((state, index) => widths.map(width => ({ state, width, fresh: index > 0 })));
  log(`Capturing ${jobs.length} references (${sourceStates.length} states x ${widths.length} widths) in ${lanes} lane(s)`);
  const pages = [{ page, close: async () => {}, dirty: true }];
  for (let lane = 1; lane < lanes && openLane; lane++) {
    try {
      const extra = await openLane();
      await preparePage(extra.page, capture);
      pages.push({ ...extra, dirty: true });
    } catch (error) { problems.push(`Parallel capture page unavailable: ${error.message}`); break; }
  }
  let next = 0;
  let done = 0;
  try {
    await Promise.all(pages.map(async (lane) => {
      while (next < jobs.length) {
        const { state, width, fresh } = jobs[next++];
        try {
          await resizeTo(lane.page, width, height);
          if (fresh || lane.dirty) await navigate(lane.page, css.sourceUrl);
          lane.dirty = fresh;
          for (const action of state.steps) await step(lane.page, action, identity);
          await settle(lane.page);
          const file = resolve(dir, "references", `${state.id}-${width}.png`);
          await shoot(lane.page, file, capture);
          (references[state.id] ||= {})[width] = file;
          (snapshots[state.id] ||= {})[width] = await snapshot(lane.page);
          if (css.containerQueries.length) {
            try { observations.push(await captureContainerObservation(lane.page, css, state.id)); }
            catch (error) { problems.push(`No container observation for ${state.id} at ${width}px (its container rules need scenarios): ${error.message}`); }
          }
        } catch (error) {
          lane.dirty = true;
          problems.push(`State ${state.id} at ${width}px: ${error.message}`);
        }
        if (++done % 10 === 0) log(`${done}/${jobs.length} captured`);
      }
    }));
  } finally {
    for (const lane of pages.slice(1)) await lane.close().catch(() => {});
  }

  const containers = [];
  const draft = { inventory: { sourceUrl: css.sourceUrl, states: sourceStates.map(s => ({ id: s.id, kind: "source" })), breakpoints: [...new Set([...css.breakpoints, ...extraBreakpoints])] }, responsiveCss: css, containerObservations: observations };
  const live = css.containerQueries.filter(query => !hasCompleteAbsenceEvidence(draft, query));
  if (live.length) {
    log(`Capturing ${live.length} live container quer${live.length === 1 ? "y" : "ies"}`);
    await resizeTo(page, 1440, height);
    await navigate(page, css.sourceUrl);
    const located = await evaluate(page, `(${pageProbe.toString()})("containers", ${JSON.stringify(live)})`);
    for (const [index, query] of live.entries()) {
      const selector = stateSpec.containers?.[query.condition] ?? located[index]?.selector ?? null;
      const threshold = containerThreshold(query.condition, located[index] || {});
      const entry = { query, selector, threshold, references: {} };
      containers.push(entry);
      if (!selector || !threshold) { problems.push(`Container query ${query.condition}: name its container and sizes in the plan`); continue; }
      for (const width of widths) {
        try {
          await resizeTo(page, width, height);
          const before = await evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.getAttribute('style') ?? null`);
          await step(page, { kind: "resize-container", selector, width: Math.ceil(threshold) + 1 }, identity);
          await settle(page);
          const file = resolve(dir, "references", `container-${index + 1}-${width}.png`);
          await shoot(page, file, capture);
          entry.references[width] = file;
          await evaluate(page, `(e=>{${JSON.stringify(before)}===null?e.removeAttribute('style'):e.setAttribute('style',${JSON.stringify(before)})})(document.querySelector(${JSON.stringify(selector)}))`);
        } catch (error) { problems.push(`Container ${query.condition} at ${width}px: ${error.message}`); }
      }
    }
  }
  await clearScreenRender(page);
  if (pages[0].dirty || live.length) await navigate(page, css.sourceUrl).catch(error => problems.push(error.message));

  writeFileSync(join(dir, "container-observations.json"), JSON.stringify(observations, null, 2) + "\n");
  writeFileSync(join(dir, "inventory.json"), JSON.stringify({ widths, snapshots }, null, 2) + "\n");
  const { plan, notes } = planSkeleton({ css, states, snapshots, observations, references, containers, height, capture, extraBreakpoints, extraControls: stateSpec.controls || [] });
  const planFile = join(dir, "plan.json");
  const merged = mergePlan(existsSync(planFile) ? JSON.parse(readFileSync(planFile, "utf8")) : null, plan);
  writeFileSync(planFile, JSON.stringify(merged, null, 2) + "\n");
  const remaining = lintPlan(merged);
  return { plan: planFile, widths, states: states.map(s => s.id), controls: merged.inventory.controls.length, references: Object.values(references).reduce((n, r) => n + Object.keys(r).length, 0) + containers.reduce((n, c) => n + Object.keys(c.references).length, 0), seconds: Math.round((Date.now() - started) / 1000), captureProblems: problems, toFill: remaining, ...notes };
}

export function normalizeStates(list = []) {
  if (!Array.isArray(list)) throw new Error("states.json must be an array of states or { states, containers, controls }");
  const states = list.map(state => ({ ...state, kind: state.kind ?? "source", steps: state.steps ?? [] }));
  if (!states.some(state => state.id === "default")) states.unshift({ id: "default", kind: "source", path: "/", steps: [] });
  for (const state of states) {
    if (!/^[a-zA-Z0-9_-]+$/.test(state.id || "")) throw new Error(`State ids must be filename-safe: ${state.id}`);
    if (!["source", "prototype-boundary"].includes(state.kind)) throw new Error(`Unknown state kind: ${state.kind}`);
    if (!Array.isArray(state.steps)) throw new Error(`State ${state.id} steps must be an array of actions`);
  }
  if (new Set(states.map(state => state.id)).size !== states.length) throw new Error("State ids must be unique");
  // The default state is captured first, without a reload between widths.
  return [...states.filter(state => state.id === "default"), ...states.filter(state => state.id !== "default")];
}

// ---------------------------------------------------------------------------
// CLI

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
function flag(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) args.splice(index, 1);
  return index >= 0;
}

async function cli() {
  const { browserArguments, readSession, browserSessionPath } = await import("./cdp/session-context.mjs");
  const args = browserArguments();
  let command = args[0];
  if (/^https?:\/\//.test(command ?? "")) command = "capture";
  else args.shift();
  if (command === "capture") {
    const states = option(args, "--states");
    const breakpoints = option(args, "--breakpoints");
    const height = Number(option(args, "--height", "900"));
    const captureProfile = option(args, "--capture");
    const lanes = Number(option(args, "--concurrency", option(args, "--lanes", "3")));
    const port = Number(option(args, "--port", "9333"));
    const [url, dir] = args;
    if (!url || !dir) throw new Error("usage: prepare-plan.mjs capture <exact-live-url> <plan-dir> --browser-session <path> [--states states.json] [--breakpoints 900,1100] [--height 900] [--capture json] [--concurrency 3]");
    if (!browserSessionPath()) throw new Error("Pass --browser-session <path> from product-page.mjs");
    const { findPage } = await import("./cdp/attach.mjs");
    const tab = await findPage(url, port);
    const session = readSession();
    const page = await connect(tab.webSocketDebuggerUrl);
    const openLane = async () => {
      const browser = await connect(session.browserId);
      try {
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true, background: true });
        const list = await (await fetch(`http://localhost:${session.port}/json/list`)).json();
        const extra = await connect(list.find(target => target.id === targetId).webSocketDebuggerUrl);
        return { page: extra, close: async () => { extra.close(); const b = await connect(session.browserId); try { await b.send("Target.closeTarget", { targetId }); } finally { b.close(); } } };
      } finally { browser.close(); }
    };
    try {
      const result = await capturePlan({
        page, url, dir: resolve(dir), height, lanes, openLane,
        states: states ? JSON.parse(readFileSync(states, "utf8")) : {},
        capture: captureProfile ? JSON.parse(captureProfile) : undefined,
        extraBreakpoints: breakpoints ? breakpoints.split(",").map(Number) : [],
        log: (line) => console.error(line),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally { page.close(); }
  } else if (command === "lint") {
    const [file] = args;
    if (!file) throw new Error("usage: prepare-plan.mjs lint <plan.json>");
    const problems = lintPlan(JSON.parse(readFileSync(file, "utf8")));
    for (const problem of problems) console.log(problem);
    console.log(problems.length ? `${problems.length} problem(s)` : "Plan is complete");
    process.exitCode = problems.length ? 1 : 0;
  } else if (command === "run") {
    const only = option(args, "--only");
    const match = option(args, "--match");
    const widths = option(args, "--widths");
    const lanesFlag = option(args, "--concurrency", option(args, "--lanes"));
    const concurrency = lanesFlag ? verifyConcurrency(lanesFlag) : verifyConcurrency();
    const out = option(args, "--out");
    const bail = flag(args, "--bail");
    const noBuild = flag(args, "--no-build");
    const [target, file] = args;
    if (!target || !file) throw new Error("usage: prepare-plan.mjs run <workspace-or-dist> <plan.json> [--only id,id] [--match regex] [--widths 320,1440] [--bail] [--concurrency N] [--out dir] [--no-build]");
    let folder = resolve(target);
    if (existsSync(join(folder, "package.json"))) {
      if (!noBuild) execFileSync("npm", ["run", "build", "--silent"], { cwd: folder, stdio: ["ignore", "ignore", "inherit"] });
      folder = join(folder, "dist");
    }
    const plan = JSON.parse(readFileSync(file, "utf8"));
    preflightPlan(folder, plan);
    const output = resolve(out ?? join(resolve(file, ".."), "local-check"));
    const started = Date.now();
    const results = await runPlan(folder, plan, output, {
      only: match ? new RegExp(match) : only?.split(","),
      widths: widths && widths !== "all" ? widths.split(",").map(Number) : undefined,
      bail, concurrency,
      onResult: (result) => { if (result.outcome !== "passed") console.log(`FAIL ${result.id}: ${result.problems.join(" | ")}  (${join(output, result.id + ".png")})`); },
    });
    writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2));
    const failed = results.filter(result => result.outcome !== "passed").length;
    console.log(`${results.length - failed}/${results.length} passed in ${Math.round((Date.now() - started) / 1000)}s${bail && failed ? " (stopped at first failure)" : ""}; results in ${output}`);
    process.exitCode = failed ? 1 : 0;
  } else {
    throw new Error("usage: prepare-plan.mjs <capture|lint|run> ... (see the header of tools/prepare-plan.mjs)");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((error) => { console.error(error.message); process.exit(1); });
}
