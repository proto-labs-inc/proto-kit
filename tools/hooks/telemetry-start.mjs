#!/usr/bin/env node
/** Session-start and prompt-submit reporting is best effort: a watcher that
 *  quit on idle starts again when the person comes back, and a live one
 *  makes this a no-op. Linking retries in the same chat. Prints nothing,
 *  since a prompt hook's output would reach the model. */
import { readFileSync } from "node:fs";
import { codexRollout, sessionAt } from "../debug-report.mjs";
import { ensureReporter } from "../telemetry.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const id = input.session_id ?? input.sessionId ?? input.thread_id;
  const path = input.transcript_path ?? (id ? codexRollout(id) : null);
  const harness = path ? sessionAt(path).harness : "unknown";
  await ensureReporter({ id, path }, `${input.hook_event_name ?? "hook"} ${harness} keys ${Object.keys(input).join(",")}`);
} catch {}
process.exit(0);
