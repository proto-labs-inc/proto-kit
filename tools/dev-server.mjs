/**
 * The workspace's dev server, for the build's tools: replicate.mjs
 * renders parts in it, check-states.mjs and previews.mjs load the
 * prototype's views from it. One of them starts it when it is not up
 * and stops it again when it is done, unless asked to keep it; a server
 * already up (the serve skill's supervised run, or an earlier tool's
 * --keep-dev) is used as it is and left alone.
 *
 *   const dev = await ensureDevServer({ workspace, logPath });
 *   ... dev.url is http://localhost:<port> ...
 *   dev.stop();   // no-op when the server was already up
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Whether an address answers with a 2xx within a moment. */
export async function answers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * `workspace` is the prototype's folder; its public/prototype.json
 * carries the port. `logPath` takes the server's output (a reload's
 * reason is in there); `keep` leaves the server up after stop().
 */
export async function ensureDevServer({ workspace, logPath, keep = false, timeoutMs = 30_000 }) {
  const manifest = JSON.parse(readFileSync(join(workspace, "public", "prototype.json"), "utf8"));
  const url = `http://localhost:${manifest.port}`;
  if (await answers(`${url}/prototype.json`)) return { url, port: manifest.port, started: false, stop() {} };
  const log = openSync(logPath, "a");
  const child = spawn("pnpm", ["dev"], {
    cwd: workspace,
    stdio: ["ignore", log, log],
    detached: true,
  });
  const until = Date.now() + timeoutMs;
  while (!(await answers(`${url}/prototype.json`))) {
    if (Date.now() > until) throw new Error(`the dev server did not answer on ${manifest.port} within ${timeoutMs / 1000} s (its log: ${logPath})`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const stop = () => {
    if (keep) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  process.on("exit", stop);
  return { url, port: manifest.port, started: true, stop };
}
