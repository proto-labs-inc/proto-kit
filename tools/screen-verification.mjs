/** Current starter acceptance contract. Kept in parity with cloud screen-verification.ts. */
export const VERSION = 4;
/** Both sides of a CSS width boundary. A fractional boundary (max-width:
 *  767.98px) switches between its floor and ceiling. An integer one switches
 *  between b-1 and b (min-width) or b and b+1 (max-width); the inventory does
 *  not record which, so both neighbours are the two possible sides. */
export function boundarySides(boundary) {
  const sides = Number.isInteger(boundary) ? [boundary - 1, boundary, boundary + 1]
    : [Math.floor(boundary), Math.ceil(boundary)];
  return sides.filter(width => width >= 1 && width <= 10000);
}
/** 320, each breakpoint inside the 320–1440 range, 1440: the edges of the layout bands. */
function bandEdges(inventory) {
  return [...new Set([320, ...inventory.breakpoints.filter(b => b > 320 && b < 1440), 1440])].sort((a, b) => a - b);
}
const bandMidpoint = (left, right) => Math.round((left + right) / 2);
/** The layout-band widths visual and responsive checks run at: the 320 and
 *  1440 endpoints, both sides of every breakpoint, and one midpoint per band. */
export function widthsFor(inventory) {
  const points = new Set([320, 1440]);
  for (const boundary of inventory.breakpoints)
    for (const width of boundarySides(boundary)) points.add(width);
  const edges = bandEdges(inventory);
  for (let i = 1; i < edges.length; i++) {
    const midpoint = bandMidpoint(edges[i - 1], edges[i]);
    if (midpoint > edges[i - 1] + 1 && midpoint < edges[i] - 1) points.add(midpoint);
  }
  return [...points].sort((a, b) => a - b);
}
/** Bands the plan marks for extra control checks (`inventory.interactionBands`,
 *  each `[left, right]`: two neighbouring band edges, e.g. a breakpoint where a
 *  control changes form). Throws on anything else. */
export function interactionBands(inventory) {
  const bands = inventory.interactionBands ?? [];
  const edges = bandEdges(inventory);
  if (!Array.isArray(bands) || bands.some(band => !Array.isArray(band) || band.length !== 2
      || !edges.includes(band[0]) || edges[edges.indexOf(band[0]) + 1] !== band[1]))
    throw new Error("interactionBands must list [left, right] pairs of neighbouring band edges (320, a breakpoint, 1440).");
  return bands;
}
/** Widths a category must be checked at. Layout (visual, responsive) sweeps
 *  the bands; controls run at one phone and one desktop width plus the middle
 *  of each marked band; reload and isolation do not depend on width. */
export function widthsForCategory(inventory, category) {
  if (["visual", "responsive"].includes(category)) return widthsFor(inventory);
  if (["interaction", "keyboard"].includes(category))
    return [...new Set([320, 1440, ...interactionBands(inventory).map(([l, r]) => bandMidpoint(l, r))])].sort((a, b) => a - b);
  if (["state", "isolation"].includes(category)) return [1440];
  throw new Error("Invalid scenario category.");
}
/** The widths one control's interaction and keyboard checks run at.
 *  `control.widths` (recorded by prepare-plan.mjs) lists the layout widths
 *  where the source shows the control; without it the control is treated as
 *  visible everywhere (widthsForCategory). The category's widths are kept
 *  only where the control is visible. A control visible at neither 320 nor
 *  1440 (a tablet-only control) also runs at its fallback: the visible width
 *  nearest a layout-band midpoint (the wider on a tie), so every control is
 *  checked at least once. */
export function widthsForControl(inventory, control) {
  const category = widthsForCategory(inventory, "interaction");
  const visible = control?.widths;
  if (visible === undefined) return category;
  if (!Array.isArray(visible) || !visible.length || visible.some(width => !Number.isInteger(width) || width < 1 || width > 10000))
    throw new Error(`Control ${control.id} widths must list the integer widths where it is visible.`);
  const widths = category.filter(width => visible.includes(width));
  if (!visible.includes(320) && !visible.includes(1440)) {
    const edges = bandEdges(inventory);
    const midpoints = edges.slice(1).map((right, i) => bandMidpoint(edges[i], right));
    const distance = (width) => Math.min(...midpoints.map(midpoint => Math.abs(midpoint - width)));
    const fallback = [...visible].sort((a, b) => distance(a) - distance(b) || b - a)[0];
    widths.push(fallback);
  }
  return [...new Set(widths)].sort((a, b) => a - b);
}
/** A container scenario resizes its own container; it runs at every layout
 *  width as authored, whatever its category. */
export const isContainerScenario = (scenario) =>
  typeof scenario.containerQuery === "string" || !!scenario.steps?.some(step => step?.kind === "resize-container");
/** The widths the runner executes one plan scenario at. */
export function widthsForScenario(inventory, scenario) {
  if (isContainerScenario(scenario)) return widthsFor(inventory);
  if (["interaction", "keyboard"].includes(scenario.category))
    return widthsForControl(inventory, inventory.controls?.find(control => control.id === scenario.target));
  return widthsForCategory(inventory, scenario.category);
}
/** The widths a plan needs reference PNGs at: the union of
 *  widthsForScenario over its screenshot-compared (visual and responsive)
 *  scenarios. prepare-plan.mjs captures exactly these; lint requires them. */
export function referenceWidths(inventory, scenarios) {
  const widths = new Set();
  for (const scenario of scenarios)
    if (["visual", "responsive"].includes(scenario.category))
      for (const width of widthsForScenario(inventory, scenario)) widths.add(width);
  return [...widths].sort((a, b) => a - b);
}
export const resizeOrigin = (width) => width < 1024 ? 1440 : 390;
export function validateVerification(report, screen) {
  const fail = (message) => {
    throw new Error(message);
  };
  const build = screen.metadata?.preparedBuild;
  const acceptance = screen.metadata?.staffAcceptance;
  if (acceptance?.kind === "staff-accepted"
    && typeof acceptance.acceptedBy === "string" && acceptance.acceptedBy.length > 0
    && typeof acceptance.reason === "string" && acceptance.reason.length > 0
    && typeof acceptance.acceptedAt === "string" && Number.isFinite(Date.parse(acceptance.acceptedAt))
    && /^[a-f0-9]{64}$/.test(acceptance.sourceChecksum)
    && /^[a-f0-9]{64}$/.test(acceptance.buildChecksum)
    && acceptance.sourceUrl === screen.source_url
    && acceptance.sourceChecksum === screen.bundle_checksum
    && build?.sourceChecksum === screen.bundle_checksum
    && acceptance.buildChecksum === build?.checksum) return acceptance;
  if (
    report?.version !== VERSION ||
    !build ||
    report.sourceChecksum !== screen.bundle_checksum ||
    build.sourceChecksum !== screen.bundle_checksum ||
    report.buildChecksum !== build.checksum
  )
    fail(
      "Current verification must match the exact source and prepared build.",
    );
  const inventory = report.inventory;
  if (
    !inventory ||
    inventory.sourceUrl !== screen.source_url ||
    !Array.isArray(inventory.controls) ||
    !Array.isArray(inventory.states) ||
    !inventory.states.length ||
    !Array.isArray(inventory.breakpoints) ||
    !Number.isFinite(Date.parse(inventory.capturedAt))
  )
    fail("Missing reference interaction inventory.");
  if (!Array.isArray(report.scenarios) || !report.scenarios.length)
    fail("Missing verification scenarios.");
  for (const ids of [
    inventory.controls.map((c) => c.id),
    inventory.states.map(state => state?.id),
    report.scenarios.map((s) => s.id),
  ]) {
    if (
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      fail("Verification IDs must be unique.");
  }
  if (
    inventory.breakpoints.some((b) => !Number.isFinite(b) || b < 2 || b > 9999)
  )
    fail("Invalid breakpoints.");
  if (
    inventory.controls.some(
      (c) => !c.expected || !["enabled", "disabled"].includes(c.state),
    )
  )
    fail("Invalid controls.");
  validateStateInventory(inventory);
  for (const s of report.scenarios) {
    const controlScenario = ["interaction", "keyboard"].includes(s.category);
    if (controlScenario) {
      if (!inventory.controls.some(control => control.id === s.target)) fail("Unknown control target.");
    } else {
      const state = inventory.states.find(state => state.id === s.target);
      if (!state) fail("Unknown state target.");
      if (state.kind === "prototype-boundary" && s.category === "visual")
        fail("Boundary states use behavioral checks, not source visual comparisons.");
    }
    if (s.category === "responsive" && s.resizedFrom !== resizeOrigin(s.viewport?.width))
      fail("Responsive evidence must include a live resize from the opposite layout.");
    if (
      s.outcome !== "passed" ||
      !Array.isArray(s.problems) ||
      s.problems.length ||
      !s.viewport ||
      !Number.isInteger(s.viewport.width) ||
      !Number.isInteger(s.viewport.height) ||
      s.viewport.height < 1 ||
      s.viewport.height > 10000 ||
      !Array.isArray(s.evidence) ||
      !s.evidence.length ||
      s.evidence.some(
        (e) =>
          !new RegExp(
            `^screen-indexes/${screen.index_id}/[a-f0-9]{64}\\.png$`,
          ).test(e),
      )
    )
      fail("Every required scenario needs passing evidence.");
    if (
      ![
        "visual",
        "interaction",
        "keyboard",
        "responsive",
        "state",
        "isolation",
      ].includes(s.category)
    )
      fail("Invalid scenario category.");
  }
  const checked = new Set(report.scenarios.map(s => `${s.category}\0${s.target}\0${s.viewport.width}`));
  const has = (category, target, width) => checked.has(`${category}\0${target}\0${width}`);
  try { interactionBands(inventory); } catch (error) { fail(error.message); }
  for (const state of inventory.states) {
    const categories = state.kind === "source"
      ? ["visual", "responsive", "state", "isolation"]
      : ["responsive", "state", "isolation"];
    for (const category of categories)
      for (const width of widthsForCategory(inventory, category))
        if (!has(category, state.id, width))
          fail(`Missing ${category} check for ${state.id} at ${width}px.`);
  }
  for (const control of inventory.controls) {
    let widths;
    try { widths = widthsForControl(inventory, control); } catch (error) { fail(error.message); }
    for (const category of ["interaction", "keyboard"])
      for (const width of widths)
        if (!has(category, control.id, width))
          fail(`Missing ${category} check for ${control.id} at ${width}px.`);
  }
  return report;
}

export function validateStateInventory(inventory) {
  const states = inventory?.states;
  if (!Array.isArray(states) || !states.length || states.length > 300
    || states.some(state => !state || typeof state.id !== "string" || !state.id
      || !["source", "prototype-boundary"].includes(state.kind))
    || new Set(states.map(state => state.id)).size !== states.length)
    throw new Error("Supply unique typed verification states.");
  if (!states.some(state => state.kind === "source")) throw new Error("At least one source state is required.");
  for (const state of states) {
    const keys = state.kind === "source" ? ["id", "kind"]
      : ["id", "kind", "originatingControl", "destination", "returnControl", "returnState"];
    if (Object.keys(state).some(key => !keys.includes(key))
      || keys.some(key => typeof state[key] !== "string" || !state[key]))
      throw new Error("Invalid verification state declaration.");
    if (state.kind !== "prototype-boundary") continue;
    if (!inventory.controls?.some(control => control.id === state.originatingControl && control.state === "enabled")
      || !inventory.controls?.some(control => control.id === state.returnControl && control.state === "enabled")
      || state.originatingControl === state.returnControl
      || !states.some(target => target.id === state.returnState && target.kind === "source"))
      throw new Error("Boundary states need enabled entry and return controls and a source return state.");
  }
}

// Resolve policy from the inventory, never from a scenario-authored skip flag.
export function comparisonState(inventory, scenario) {
  validateStateInventory(inventory);
  const state = inventory.states.find(state => state.id === scenario.target);
  if (!state) throw new Error("Unknown state target.");
  if (scenario.category === "visual" && state.kind !== "source")
    throw new Error("Boundary states use behavioral checks, not source visual comparisons.");
  return state;
}
