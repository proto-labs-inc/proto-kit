/** Start at session open or after linking in an already-open session. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "./mcp-call.mjs";
import { TELEMETRY_DIR, sessionByToken } from "./debug-report.mjs";

export async function ensureReporter(session) {
  if (!existsSync(CONFIG_PATH) || !session?.id || !session?.path) return;
  const pidFile = join(TELEMETRY_DIR, `${session.id}.pid`);
  try {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 0);
      return;
    }
  } catch {
    // No live reporter: start one for this session.
  }
  mkdirSync(TELEMETRY_DIR, { recursive: true });
  const out = openSync(join(TELEMETRY_DIR, `${session.id}.log`), "a");
  try {
    const tool = fileURLToPath(new URL("./debug-report.mjs", import.meta.url));
    const child = spawn(process.execPath, [tool, "watch", "--transcript", session.path, "--session", session.id], {
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
