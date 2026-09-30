/**
 * The workspace's dev server, for the build's tools: replicate.mjs
 * renders parts in it, check-states.mjs and previews.mjs load the
 * prototype's views from it. One of them starts it when it is not up
 * and stops it again when it is done, unless asked to keep it; a server
 * already up (the serve skill's supervised run, or an earlier tool's
 * --keep-dev) is used as it is and left alone.
 *
 * Whatever answers on the workspace's port must be this workspace:
 * tools/scaffold.mjs writes public/__proto-workspace.json, a token
 * the dev server serves at /__proto-workspace.json, and it is read
 * back before anything renders. Another prototype's server on the
 * port (its record was written when the port looked free) is named in
 * one line and the tool stops, instead of every check rendering in
 * the wrong app.
 *
 *   const dev = await ensureDevServer({ workspace, logPath });
 *   ... dev.url is http://localhost:<port> ...
 *   dev.stop();   // no-op when the server was already up
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_PATH } from "./mcp-call.mjs";

export const IDENTITY_FILE = "__proto-workspace.json";

/** The workspace's own identity record, or null for a workspace scaffolded before it existed. */
export function workspaceIdentity(workspace) {
  const path = join(workspace, "public", IDENTITY_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

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
 * Who answers on the workspace's port: "nobody", "this" (the token
 * matches), or "other" with what was found. A workspace without an
 * identity file is known by its prototype.json name.
 */
export async function whoAnswers(url, workspace) {
  const identity = workspaceIdentity(workspace);
  const get = async (path) => {
    try {
      const res = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { status: res.status, body: null };
      return { status: res.status, body: await res.text() };
    } catch {
      return null;
    }
  };
  const manifest = await get("/prototype.json");
  if (manifest === null) return { who: "nobody" };
  let served = null;
  try {
    served = JSON.parse(manifest.body ?? "");
  } catch {
    // Something else than a prototype answers on the port.
  }
  if (identity) {
    const answer = await get(`/${IDENTITY_FILE}`);
    let token = null;
    try {
      token = JSON.parse(answer?.body ?? "").token;
    } catch {
      // No identity served: not this workspace.
    }
    if (token === identity.token) return { who: "this" };
    return { who: "other", found: describe(served, answer) };
  }
  const own = JSON.parse(readFileSync(join(workspace, "public", "prototype.json"), "utf8"));
  if (served?.name === own.name) return { who: "this" };
  return { who: "other", found: describe(served, null) };
}

function describe(served, identityAnswer) {
  if (served?.name) return `the prototype "${served.name}"`;
  if (identityAnswer?.status === 200) return "another prototype";
  return "something that is not a prototype workspace";
}

/**
 * `workspace` is the prototype's folder; its public/prototype.json
 * carries the port. `logPath` takes the server's output (a reload's
 * reason is in there); `keep` leaves the server up after stop().
 */
export async function ensureDevServer({ workspace, logPath, keep = false, timeoutMs = 30_000 }) {
  const manifest = JSON.parse(readFileSync(join(workspace, "public", "prototype.json"), "utf8"));
  const url = `http://localhost:${manifest.port}`;
  const before = await whoAnswers(url, workspace);
  if (before.who === "this") return { url, port: manifest.port, started: false, stop() {} };
  if (before.who === "other") {
    throw new Error(`port ${manifest.port} is serving ${before.found}, not ${workspace}: stop that server or give this workspace another port (public/prototype.json and vite.config.ts must agree)`);
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const log = openSync(logPath, "a");
  const child = spawn("pnpm", ["dev"], {
    cwd: workspace,
    env: { ...process.env, PROTO_PACKAGES: config.packages },
    stdio: ["ignore", log, log],
    detached: true,
  });
  // The server outlives a tool that keeps it; the handle must not keep
  // that tool's event loop alive until its watchdog fires (explain-diff
  // said it gave up a minute after printing its answer).
  child.unref();
  const stop = () => {
    if (keep) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  const until = Date.now() + timeoutMs;
  for (;;) {
    const now = await whoAnswers(url, workspace);
    if (now.who === "this") break;
    if (now.who === "other") {
      stop();
      throw new Error(`port ${manifest.port} answered with ${now.found} while this workspace's server was starting: another server took the port (its log: ${logPath})`);
    }
    if (Date.now() > until) {
      stop();
      throw new Error(`the dev server did not answer on ${manifest.port} within ${timeoutMs / 1000} s (its log: ${logPath})`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.on("exit", stop);
  return { url, port: manifest.port, started: true, stop };
}
