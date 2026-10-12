import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { callTool } from "./mcp-call.mjs";

/** Forward a screen's durable copy log to its approved inventory entry. */
export async function reportScreenBuild({ codebase, runDir, transport = callTool }) {
  const record = join(runDir, "workspace.json");
  if (!existsSync(record)) return;
  const screen = JSON.parse(readFileSync(record, "utf8")).screenIndex;
  if (!screen) return;
  const file = join(runDir, "events.jsonl");
  if (!existsSync(file)) return;
  const cacheFile = join(runDir, "screen-progress.json");
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : { after: 0, captures: {} };
  const records = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const pending = records.slice(cache.after);
  if (!pending.length) return;
  async function invoke(args) {
    const result = await transport("screen_index", { codebase, ...args });
    const content = result?.content?.find((item) => item.type === "text")?.text;
    if (result?.isError) throw new Error(content ?? "Screen progress rejected.");
    return JSON.parse(content);
  }
  await invoke({ operation: "replication-check", indexId: screen.indexId, version: screen.version, entryId: screen.entryId });
  const paths = [...new Set(pending.flatMap(({event}) => [event.image, event.diff].filter((value) => value?.startsWith("file://"))))];
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, paths.length)}, async () => {
    while (next < paths.length) {
      const uri = paths[next++];
      if (cache.captures[uri]) continue;
      const path = realpathSync(fileURLToPath(uri));
      const rel = relative(realpathSync(runDir), path);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Capture must be inside its screen build.");
      const bytes = readFileSync(path);
      if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Screen progress captures must be PNGs.");
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const upload = await invoke({ operation: "capture", indexId: screen.indexId, checksum, size: bytes.length });
      const response = await fetch(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) }, body: bytes });
      if (!response.ok) throw new Error(`Screen capture upload failed (${response.status}).`);
      cache.captures[uri] = `proto-screen://${screen.indexId}/${checksum}.png`;
    }
  }));
  writeFileSync(cacheFile, JSON.stringify(cache));
  for (let start = 0; start < pending.length; start += 150) {
    const batch = pending.slice(start, start + 150).map(({at,event}) => ({at, event: {...event,
      ...(event.image ? {image: cache.captures[event.image] ?? event.image} : {}),
      ...(event.diff ? {diff: cache.captures[event.diff] ?? event.diff} : {}),
    }}));
    await invoke({ operation: "build-events", indexId: screen.indexId, version: screen.version, entryId: screen.entryId, events: batch });
    cache.after += batch.length;
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return { reported: pending.length, total: cache.after };
}
