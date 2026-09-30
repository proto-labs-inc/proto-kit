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
 * A site that cannot be reached does not stop a build: the first call
 * that fails switches the reporter to the build folder, says so once,
 * and every event and picture after it lands there (events.jsonl,
 * captures/), the same as --no-send.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "./mcp-call.mjs";

const BATCH = 150;
const FLUSH_MS = 700;
const FLUSH_AT = 40;

export function createReporter({ codebase, briefId, runDir, sink = "site" }) {
  const waiting = [];
  let timer = null;
  let sending = Promise.resolve();

  const toFile = (error) => {
    if (sink === "file") return;
    sink = "file";
    console.error(`… the site could not be reached (${error.message.split("\n")[0]}); the build's events and pictures are kept in ${runDir} from here`);
  };
  const toFolder = (events) => {
    mkdirSync(runDir, { recursive: true });
    const lines = events.map((event) => JSON.stringify({ at: new Date().toISOString(), event })).join("\n");
    writeFileSync(join(runDir, "events.jsonl"), lines + "\n", { flag: "a" });
  };
  const deliver = async (events) => {
    if (sink === "file") return toFolder(events);
    try {
      for (let i = 0; i < events.length; i += BATCH) {
        const result = await callTool("report_build_events", { codebase, briefId, events: events.slice(i, i + BATCH) });
        if (result?.isError) throw new Error(`report_build_events: ${result?.content?.[0]?.text ?? ""}`);
      }
    } catch (error) {
      toFile(error);
      toFolder(events);
    }
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (waiting.length === 0) return sending;
    const events = waiting.splice(0, waiting.length);
    // One call at a time, in order: the site keeps events in sequence.
    sending = sending.then(() => deliver(events));
    return sending;
  };

  const send = (events) => {
    waiting.push(...events);
    if (waiting.length >= FLUSH_AT) flush();
    else if (!timer) timer = setTimeout(flush, FLUSH_MS);
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
      const result = await callTool("begin_build_capture", { codebase, briefId, contentType, size: bytes.length });
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
      toFile(error);
      return toCaptures(bytes);
    }
  };

  return { send, flush, upload };
}
