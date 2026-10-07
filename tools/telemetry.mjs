/** Start at session open or after linking in an already-open session. */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "./mcp-call.mjs";
import { TELEMETRY_DIR, sessionByToken } from "./debug-report.mjs";

const KIT = dirname(dirname(fileURLToPath(import.meta.url)));

/** One line in the session's log, so a missing report can be explained. */
function logStart(id, line) {
  try {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    appendFileSync(join(TELEMETRY_DIR, `${id}.log`), `${new Date().toISOString()} start ${line}\n`);
  } catch {}
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Claim the pid file atomically: hooks at session start, on each prompt
 *  and after linking can race, and check-then-write let two watchers in.
 *  Returns the live owner's pid when someone else holds it, else null. */
function claim(pidFile) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      closeSync(openSync(pidFile, "wx"));
      writeFileSync(pidFile, String(process.pid));
      return null;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let text = "";
    try {
      text = readFileSync(pidFile, "utf8");
    } catch {
      continue;
    }
    // Empty means a claimer between its create and its write.
    if (text === "" || alive(Number(text))) return Number(text) || "starting";
    try {
      if (readFileSync(pidFile, "utf8") === text) unlinkSync(pidFile);
    } catch {}
  }
  return "busy";
}

/** Start this session's watcher unless one is alive. `info` (harness, hook
 *  keys) goes in the log beside the decision. Returns the decision. */
export async function ensureReporter(session, info = "") {
  const decide = (decision) => {
    if (session?.id) logStart(session.id, `${info ? `${info} ` : ""}${decision} kit ${KIT}`);
    return decision;
  };
  if (!existsSync(CONFIG_PATH)) return decide("no config");
  if (!session?.id || !session?.path) return decide("no path");
  mkdirSync(TELEMETRY_DIR, { recursive: true });
  const pidFile = join(TELEMETRY_DIR, `${session.id}.pid`);
  const owner = claim(pidFile);
  if (owner !== null) return decide(`alive pid ${owner}`);
  const out = openSync(join(TELEMETRY_DIR, `${session.id}.log`), "a");
  try {
    const tool = fileURLToPath(new URL("./debug-report.mjs", import.meta.url));
    const child = spawn(process.execPath, [tool, "watch", "--transcript", session.path, "--session", session.id, ...(session.harness ? ["--harness", session.harness] : [])], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    // Record immediately so another hook need not wait for watch to boot.
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    return decide(`spawned pid ${child.pid}`);
  } catch (error) {
    try {
      if (readFileSync(pidFile, "utf8") === String(process.pid)) unlinkSync(pidFile);
    } catch {}
    decide(`spawn failed: ${error.message}`);
    throw error;
  } finally {
    closeSync(out);
  }
}

/** The setup code already appears in the calling chat. Never guess among
 * multiple matching chats, and never let reporting break a successful link. */
export async function startReporterAfterLink(code) {
  try {
    const session = await sessionByToken(code);
    if (!session) {
      console.error("Proto linked successfully, but this chat could not be identified for automatic debug reporting.");
      return;
    }
    await ensureReporter(session);
  } catch {
    console.error("Proto linked successfully, but automatic debug reporting could not start for this chat.");
  }
}
