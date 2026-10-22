#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, readConfig, pickCredential } from "./mcp-call.mjs";
import { repairReferenceServing } from "./repair-reference-serving.mjs";

export function toolResult(result) {
  const data = JSON.parse((result?.content ?? []).filter(c => c.type === "text").map(c => c.text).join(""));
  if (result.isError) throw new Error(data.error ?? "Reference research failed");
  return data;
}
function save(file, data) { writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2)); renameSync(`${file}.tmp`, file); }
export async function research(workspace, input, { call = callTool, maxSteps = 200, log = console.error } = {}) {
  const directory = join(workspace, ".proto-reference-research"); mkdirSync(directory, { recursive: true });
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const checkpoint = join(directory, `${fingerprint}.json`);
  let saved = existsSync(checkpoint) ? JSON.parse(readFileSync(checkpoint, "utf8")) : { requestId: randomUUID() };
  save(checkpoint, saved); // Stable id survives interruption during start.
  let run;
  if (saved.id) run = toolResult(await call("reference_research", { operation: "inspect", id: saved.id, codebase: input.codebase }));
  else {
    run = toolResult(await call("reference_research", { ...input, requestId: saved.requestId, operation: "start" }));
    saved.id = run.id; save(checkpoint, saved);
  }
  for (let step = 0; !run.terminal && step < maxSteps; step++) {
    log(`References: ${run.stage}; ${run.counts.candidates} candidates, ${run.counts.scored} scored.`);
    run = toolResult(await call("reference_research", { operation: "advance", id: run.id, codebase: input.codebase }));
    save(join(directory, `${run.id}.json`), run);
    if (!run.terminal) await new Promise(done => setTimeout(done, 1000));
  }
  if (run.status === "failed") throw new Error(`Reference run ${run.id} needs staff review. Completed work is retained. Do not fall back to scraping.`);
  return run;
}
export async function saveSelected(workspace, codebase, run, { fetcher = fetch, config = readConfig() } = {}) {
  if (!run.terminal) throw new Error("Research is still running; resume the same command.");
  const { credential } = pickCredential(config, { codebase });
  const references = []; mkdirSync(join(workspace, "public", "references"), { recursive: true });
  repairReferenceServing(workspace);
  for (const ref of run.references) {
    if (!/^[0-9a-f-]{36}$/.test(ref.id) || !/^[0-9a-f-]{36}$/.test(run.id)) throw new Error("Invalid reference identity");
    const expected = `/api/reference-research/${run.id}/images/${ref.id}`;
    if (ref.assetPath !== expected) throw new Error("Invalid reference download path");
    const response = await fetcher(new URL(expected, config.app), { headers: { Authorization: `Bearer ${credential.secret}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Reference download failed (${response.status}). Resume after resolving access or expiry.`);
    const type = response.headers.get("content-type")?.split(";")[0];
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[type];
    if (!ext) throw new Error("Reference response was not an image");
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error("Reference too large"); } chunks.push(Buffer.from(next.value)); } } finally { reader.releaseLock(); }
    const image = `references/${ref.id}.${ext}`; writeFileSync(join(workspace, "public", image), Buffer.concat(chunks));
    references.push({ app: ref.app, url: ref.url, image, note: ref.note });
  }
  const output = join(workspace, ".proto-reference-research", `${run.id}-references.json`); save(output, references);
  return { runId: run.id, status: run.status, references, file: output, sources: run.sources };
}
async function main() {
  const [workspaceArg, inputFile] = process.argv.slice(2);
  if (!workspaceArg || !inputFile) throw new Error("Usage: reference-research.mjs <workspace> <input.json>. Input: codebase, slug, variantSetId, brief, target, platform, screenshot (data URL). Supplied references are preserved separately.");
  const workspace = resolve(workspaceArg); const input = JSON.parse(readFileSync(inputFile, "utf8"));
  const run = await research(workspace, input);
  console.log(JSON.stringify(await saveSelected(workspace, input.codebase, run), null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
