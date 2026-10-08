import { createHash } from "node:crypto";
import { completionProblems, IMPORT_THEMES } from "./import-evidence.mjs";

export const STAGES = ["foundations", "core", "extended"];
export const STAGE_TITLES = { foundations: "Foundations", core: "Core components", extended: "Extended library" };

// The plan can override this for product-specific names. Unknown composites
// belong to the extended stage, never ahead of everyday controls.
export function componentStage(component) {
  if (component.stage !== undefined) {
    if (!["core", "extended"].includes(component.stage)) throw new Error(`${component.slug}: stage must be core or extended`);
    return component.stage;
  }
  const name = `${component.slug} ${component.name ?? ""}`.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
  return /(^|[\s-])(button|input|select|checkbox|radio|switch|toggle|tab|tabs|badge|menu|dropdown|dialog|modal|tooltip|textarea|text-field|form-field)([\s-]|$)/.test(name) ? "core" : "extended";
}

export function stageProblems(library, manifest, stage) {
  if (!STAGES.includes(stage)) throw new Error(`Unknown import stage: ${stage}`);
  const components = stage === "foundations" ? [] : manifest.components.filter((c) => componentStage(c) === stage);
  const problems = completionProblems(library, { ...manifest, components }, { allowEmpty: true, allowSkipped: true });
  if (!manifest.type?.length) problems.push("Import the product's type styles first.");
  for (const theme of IMPORT_THEMES) {
    if (!manifest.themes?.[theme]?.length) problems.push(`Import the product's ${theme} colours first.`);
  }
  return problems;
}

function signature(manifest, stage) {
  const components = stage === "foundations" ? [] : manifest.components.filter((c) => componentStage(c) === stage);
  return createHash("sha256").update(JSON.stringify({
    run: manifest.startedAt, themes: manifest.themes, type: manifest.type,
    surveys: manifest.verification?.surveys,
    components: components.map((c) => ({ slug: c.slug, states: c.states, status: c.status, reason: c.reason, skipKind: c.skipKind, checks: manifest.verification?.checks?.[c.slug] })),
  })).digest("hex");
}

// Re-evaluate checkpoints from current evidence, including component files.
// An edit to an earlier stage invalidates it and every later checkpoint.
export function refreshStages(library, manifest) {
  if (!manifest.importStages) return;
  let waiting = false;
  manifest.importStages = STAGES.map((id) => {
    const old = manifest.importStages.find((s) => s.id === id) ?? {};
    const problems = stageProblems(library, manifest, id);
    const complete = !waiting && !problems.length && old.signature === signature(manifest, id) && !!old.completedAt;
    const components = id === "foundations" ? [] : manifest.components.filter((c) => componentStage(c) === id);
    const verified = components.filter((c) => c.status === "done" && !stageProblems(library, { ...manifest, components: [c] }, id).length).length;
    const result = { id, title: STAGE_TITLES[id], status: complete ? "done" : waiting ? "waiting" : "active", verified, total: components.length,
      gaps: components.filter((c) => c.status === "skipped").map((c) => ({ name: c.name ?? c.slug, reason: c.reason, kind: c.skipKind })),
      remaining: components.filter((c) => stageProblems(library, { ...manifest, components: [c] }, id).length).map((c) => c.name ?? c.slug),
      completedAt: complete ? old.completedAt : null, signature: complete ? old.signature : null };
    if (!complete) waiting = true;
    return result;
  });
  if (manifest.importStages.some((s) => s.status !== "done")) manifest.completedAt = null;
}

export function requirePreviousStages(library, manifest, stage) {
  if (!STAGES.includes(stage)) throw new Error(`Unknown import stage: ${stage}`);
  if (!manifest.importStages) throw new Error("Start with import.mjs --stage foundations to record the three import stages.");
  refreshStages(library, manifest);
  for (const previous of STAGES.slice(0, STAGES.indexOf(stage))) {
    if (manifest.importStages.find((s) => s.id === previous)?.status !== "done") throw new Error(`Finish ${STAGE_TITLES[previous]} before starting ${STAGE_TITLES[stage]}.`);
  }
}

export function completeStage(library, manifest, stage, now = new Date().toISOString()) {
  requirePreviousStages(library, manifest, stage);
  const problems = stageProblems(library, manifest, stage);
  if (problems.length) throw new Error(problems.join("\n"));
  const entry = manifest.importStages.find((s) => s.id === stage);
  entry.completedAt ??= now;
  entry.signature = signature(manifest, stage);
  refreshStages(library, manifest);
}

export function requireAllStages(library, manifest) {
  if (!manifest.importStages) return; // Legacy libraries retain their existing completion rules.
  refreshStages(library, manifest);
  const pending = manifest.importStages.find((s) => s.status !== "done");
  if (pending) throw new Error(`Finish ${pending.title} before completing the import.`);
}
