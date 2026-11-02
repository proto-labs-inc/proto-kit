/** Current starter acceptance contract. Kept in parity with cloud screen-verification.ts. */
export const VERSION = 4;
/** Test the source boundaries plus endpoints and a sample in each fluid interval. */
export function widthsFor(inventory) {
  const points = new Set([320, 1440]);
  const anchors = [320, ...inventory.breakpoints.filter(b => b > 320 && b < 1440), 1440].sort((a, b) => a - b);
  for (const boundary of inventory.breakpoints) {
    for (const width of [Math.floor(boundary) - 1, Math.floor(boundary), Math.ceil(boundary), Math.ceil(boundary) + 1])
      if (width >= 1 && width <= 10000) points.add(width);
  }
  for (let i = 1; i < anchors.length; i++) {
    const midpoint = Math.round((anchors[i - 1] + anchors[i]) / 2);
    if (midpoint > anchors[i - 1] + 1 && midpoint < anchors[i] - 1) points.add(midpoint);
  }
  return [...points].sort((a, b) => a - b);
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
  const has = (category, target, width) =>
    report.scenarios.some(
      (s) =>
        s.category === category &&
        s.target === target &&
        s.viewport.width === width,
    );
  for (const width of widthsFor(inventory)) {
    for (const state of inventory.states) {
      const categories = state.kind === "source"
        ? ["visual", "responsive", "state", "isolation"]
        : ["responsive", "state", "isolation"];
      for (const category of categories)
        if (!has(category, state.id, width))
          fail(`Missing ${category} check for ${state.id} at ${width}px.`);
    }
    for (const control of inventory.controls)
      for (const category of ["interaction", "keyboard"])
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
