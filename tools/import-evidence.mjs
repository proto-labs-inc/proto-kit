import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const THEMES = ["light", "dark"];
export const ACCEPTED = ["match", "shifted", "context", "faint", "offscreen"];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function paletteDigest(palette) {
  return digest(palette.map(({ name, value, group, role }) => ({ name, value, group, ...(role ? { role } : {}) })).sort((a, b) => a.name.localeCompare(b.name)));
}

export function checkFingerprint(library, manifest, slug, theme) {
  const folder = join(library, "src", "components", slug);
  const hash = createHash("sha256");
  function visit(path, prefix = "") {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(join(path, entry.name), relative);
      else { hash.update(relative); hash.update(readFileSync(join(path, entry.name))); }
    }
  }
  visit(folder);
  hash.update(JSON.stringify({ run: manifest.startedAt, palette: paletteDigest(manifest.themes[theme]), type: manifest.type, survey: manifest.verification?.surveys?.[theme] }));
  return hash.digest("hex");
}

export function completionProblems(library, manifest, { allowEmpty = false, allowSkipped = true } = {}) {
  const problems = [];
  if (!manifest.startedAt || (!allowEmpty && !manifest.components?.length)) problems.push("Start an import and record its components first.");
  const light = (manifest.themes?.light ?? []).map((token) => token.name).sort();
  const dark = (manifest.themes?.dark ?? []).map((token) => token.name).sort();
  if (JSON.stringify(light) !== JSON.stringify(dark)) problems.push("Light and dark palettes need the same stable token names.");
  for (const theme of THEMES) {
    const survey = manifest.verification?.surveys?.[theme];
    if (!survey || survey.run !== manifest.startedAt || survey.palette !== paletteDigest(manifest.themes?.[theme] ?? [])) problems.push(`Survey ${theme} in this import and apply its palette before finishing.`);
  }
  for (const component of manifest.components ?? []) {
    if (component.status === "skipped" && allowSkipped) {
      if (!component.reason || !component.skipKind) problems.push(`${component.slug}: record the skip reason and kind.`);
      continue;
    }
    if (component.status !== "done") { problems.push(allowSkipped ? `${component.slug}: finish or explicitly skip it first.` : `${component.slug}: finish and verify it in both themes; skipped components do not complete a stage.`); continue; }
    try {
      const unit = JSON.parse(readFileSync(join(library, "src", "components", component.slug, "component.json"), "utf8"));
      if (!unit.states?.length) throw new Error("no states");
      for (const theme of THEMES) {
        const fingerprint = checkFingerprint(library, manifest, component.slug, theme);
        for (const state of unit.states) {
          const evidence = manifest.verification?.checks?.[component.slug]?.[theme]?.[state.name];
          if (!evidence || evidence.fingerprint !== fingerprint || !evidence.typecheck || !ACCEPTED.includes(evidence.verdict)) problems.push(`${component.slug} / ${state.name}: run a passing ${theme} check for the current component and palette.`);
        }
      }
    } catch { problems.push(`${component.slug}: its component files or states cannot be read.`); }
  }
  return problems;
}
