/** Current starter acceptance contract. Kept in parity with cloud screen-verification.ts. */
export const VERSION = 3;
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
    inventory.states,
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
  for (const s of report.scenarios) {
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
    for (const state of inventory.states)
      for (const category of ["visual", "responsive", "state", "isolation"])
        if (!has(category, state, width))
          fail(`Missing ${category} check for ${state} at ${width}px.`);
    for (const control of inventory.controls)
      for (const category of ["interaction", "keyboard"])
        if (!has(category, control.id, width))
          fail(`Missing ${category} check for ${control.id} at ${width}px.`);
  }
  return report;
}
