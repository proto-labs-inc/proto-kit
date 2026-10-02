#!/usr/bin/env node
/** Session-start reporting is best effort; linking retries in the same chat. */
import { readFileSync } from "node:fs";
import { codexRollout } from "../debug-report.mjs";
import { ensureReporter } from "../telemetry.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const id = input.session_id ?? input.sessionId ?? input.thread_id;
  const path = input.transcript_path ?? (id ? codexRollout(id) : null);
  await ensureReporter({ id, path });
} catch {}
process.exit(0);
