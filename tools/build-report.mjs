/**
 * Where a build's events and images go: the site, through the
 * report_build_events and begin_build_capture MCP tools, or the build
 * folder (events.jsonl, captures/) for a build under test (--no-send).
 *
 * `createReporter({ codebase, briefId, runDir, sink })` returns
 *   send(events)   queue events; they leave in one call every
 *                  FLUSH_MS or when FLUSH_AT are waiting, so a lane's
 *                  pass reaches the site while the next is being made
 *                  and twelve lanes never make twelve calls at once
 *   flush()        send what is waiting now (await it before exiting)
 *   upload(bytes)  one PNG, up now; -> the address events use
 * Everything is in-process: no node process per event.
 *
 * Site reports are persisted in outbox/ before delivery and removed only
 * after acknowledgement. A subsequent flush or invocation retries them.
 * Upload failures preserve the local capture and stop dependent reporting.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { callTool } from "./mcp-call.mjs";

const BATCH = 150;
const FLUSH_MS = 700;
const FLUSH_AT = 40;

export function createReporter({ codebase, briefId, runDir, sink = "site", transport = callTool }) {
  const waiting = [];
  let timer = null;
  let sending = Promise.resolve();

  const toFolder = (events) => {
    if (!events.length) return;
    mkdirSync(runDir, { recursive: true });
    const lines = events.map((event) => JSON.stringify({ at: new Date().toISOString(), event })).join("\n");
    writeFileSync(join(runDir, "events.jsonl"), lines + "\n", { flag: "a" });
  };
  const outbox = join(runDir, "outbox");
  const deliver = async (events) => {
    if (sink === "file") return toFolder(events);
    mkdirSync(outbox, { recursive: true });

    for (const file of readdirSync(outbox).filter(name => name.endsWith(".json")).sort()) {
      const path = join(outbox, file);
      try {
        const pending = JSON.parse(readFileSync(path, "utf8"));
        for (let i = 0; i < pending.length; i += BATCH) {
          const result = await transport("report_build_events", { codebase, briefId, events: pending.slice(i, i + BATCH) });
          if (result?.isError) throw new Error(result.content?.[0]?.text ?? "report rejected");
        }
        toFolder(pending);
        unlinkSync(path);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        console.error(`Progress delivery pending in ${path}: ${error.message}`);
        throw error;
      }
    }
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (waiting.length === 0) { sending = sending.catch(() => {}).then(() => deliver([])); return sending; }
    const events = waiting.splice(0, waiting.length);
    // One call at a time, in order: the site keeps events in sequence.
    sending = sending.catch(() => {}).then(() => deliver(events));
    return sending;
  };

  let sequence = 0;
  const send = (events) => {
    const reports = events.map(event => {
      if (["question", "answered"].includes(event.kind)) return event;
      return { ...event, reportId: event.reportId ?? randomUUID() };
    });
    if (sink === "file") waiting.push(...reports);
    else {
      mkdirSync(outbox, { recursive: true });
      const path = join(outbox, `${Date.now()}-${process.pid}-${String(sequence++).padStart(8, "0")}-${randomUUID()}`);
      writeFileSync(path + ".pending", JSON.stringify(reports));
      renameSync(path + ".pending", path + ".json");
    }
    if (waiting.length >= FLUSH_AT) void flush().catch(() => {});
    else if (!timer) timer = setTimeout(() => { void flush().catch(() => {}); }, FLUSH_MS);
  };

  const toCaptures = (bytes) => {
    const dir = join(runDir, "captures");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    writeFileSync(path, bytes);
    return `file://${path}`;
  };
  const upload = async (bytes, contentType = "image/png") => {
    if (sink === "file") return toCaptures(bytes);
    try {
      const result = await transport("begin_build_capture", { codebase, briefId, contentType, size: bytes.length });
      const text = result?.content?.[0]?.text ?? "";
      if (result?.isError) throw new Error(`begin_build_capture: ${text}`);
      const { uploadUrl, url } = JSON.parse(text);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
        body: bytes,
      });
      if (!res.ok) throw new Error(`the capture upload answered ${res.status}`);
      return url;
    } catch (error) {
      toCaptures(bytes);
      throw error;
    }
  };

  return { send, flush, upload };
}
