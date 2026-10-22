#!/usr/bin/env node
/**
 * Session-start step: a run started by an older kit still runs a Cloudflare
 * tunnel and a heartbeat, which the app no longer answers. Rewrite those
 * runs' specs without them and restart just those runs
 * (tools/repair-runs.mjs --retired), detached so the session never waits.
 * Silent and fail soft; Cursor's session-start hook calls it too.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

try {
  const tool = fileURLToPath(new URL("../repair-runs.mjs", import.meta.url));
  spawn(process.execPath, [tool, "--retired"], { detached: true, stdio: "ignore" }).unref();
} catch {}
process.exit(0);
