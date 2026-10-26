import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
import { dirname, join } from "node:path";
import { connect, evaluate } from "./cdp.mjs";
import { browserSessionPath, readSession, writeSession } from "./session-context.mjs";
import { withProcessLock } from "../process-lock.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function info(port, endpoint) {
  const response = await fetch(`http://localhost:${port}/json/${endpoint}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Chrome ${endpoint}: ${response.status}`);
  return response.json();
}
export function sourceUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Source URL must be a complete http or https URL");
  return url.href;
}
export async function acquireSourceSession(url, port = 9333, path = browserSessionPath()) {
  if (!path) throw new Error("A build identity or --browser-session path is required");
  return withProcessLock(`${path}.lock`, async () => {
    const prior = readSession(path);
    if (prior?.status === "released") throw new Error("This source session is complete; start a new run for further inspection");
    const requestedUrl = sourceUrl(url ?? prior?.requestedUrl);
    if (prior && prior.requestedUrl !== requestedUrl) throw new Error("This browser session belongs to another source URL; use a separate run");
    let version;
    try { version = await info(port, "version"); }
    catch (error) {
      if (port !== 9333) throw error;
      await exec(process.execPath, [fileURLToPath(new URL("./chrome.mjs", import.meta.url))], { timeout: 30_000 });
      version = await info(port, "version");
    }
    const browserId = version.webSocketDebuggerUrl;
    const pages = await info(port, "list");
    const existing = prior?.browserId === browserId && pages.find(tab => tab.id === prior.targetId && tab.type === "page");
    if (existing) return { tab: existing, session: prior, created: false, recovered: false };
    const browser = await connect(browserId);
    let targetId;
    try {
      ({ targetId } = await browser.send("Target.createTarget", { url: requestedUrl, newWindow: true, background: true }));
      const { windowId } = await browser.send("Browser.getWindowForTarget", { targetId });
      const session = { status: "active", port, browserId, targetId, windowId, requestedUrl, generation: (prior?.generation ?? 0) + 1 };
      // Persist ownership before waiting for login or page loading.
      writeSession(path, session);
      for (let attempt = 0; attempt < 80; attempt++) {
        const tab = (await info(port, "list")).find(candidate => candidate.id === targetId);
        if (tab) {
          const page = await connect(tab.webSocketDebuggerUrl);
          try {
            const state = await evaluate(page, "({ readyState: document.readyState, url: location.href })");
            if (state.readyState === "complete" && /^https?:\/\//.test(state.url)) {
              const [dpr, p3] = await evaluate(page, "[devicePixelRatio, matchMedia('(color-gamut: p3)').matches]");
              session.display = { dpr, colorProfile: p3 ? "display-p3-d65" : "srgb" };
              writeSession(path, session);
              return { tab: { ...tab, url: state.url }, session, created: true, recovered: Boolean(prior) };
            }
          } finally { page.close(); }
        }
        await pause(250);
      }
      throw new Error(`Source window did not finish loading: ${requestedUrl}. Its owned window is retained for recovery.`);
    } finally { browser.close(); }
  });
}

export async function resolveSourceSession(match, port = 9333) {
  const path = browserSessionPath();
  if (!path) throw new Error("A build identity or --browser-session path is required");
  const prior = readSession(path);
  const requested = prior?.requestedUrl ?? sourceUrl(match);
  const result = await acquireSourceSession(requested, prior?.port ?? port, path);
  // Legacy callers may carry a host/path selector, but it never selects a tab.
  let expected = requested;
  if (/^https?:\/\//.test(match ?? "")) expected = sourceUrl(match);
  else if (match) {
    const url = new URL(requested);
    if (`${url.host}${url.pathname}` !== match) throw new Error("Source selector does not match this build's owned URL");
  }
  if (result.tab.url !== expected) throw new Error(`Owned source window is at ${result.tab.url}; expected ${expected}. Sign in or navigate in this build's window, then retry.`);
  const run = dirname(path);
  const tree = readSession(join(run, "tree.json"));
  const steps = readSession(join(run, "steps.json"));
  const completedCopy = existsSync(join(run, "freeze.json")) || steps?.gate?.outcome === "proceed";
  const identity = `${result.session.browserId}:${result.session.targetId}:${result.session.generation}`;
  if (tree && tree.sourceIdentity !== identity && !completedCopy) {
    throw new Error("Source window recovered; resume proto-build to repeat unfinished inspection before continuing this tool");
  }
  return result.tab;
}

export async function releaseSourceSession(path = browserSessionPath()) {
  if (!path) return false;
  return withProcessLock(`${path}.lock`, async () => {
    const record = readSession(path);
    if (!record) {
      const { stopSessionRenderer } = await import("./headless.mjs");
      await stopSessionRenderer(path);
      return false;
    }
    const release = async () => {
      const version = await info(record.port, "version").catch(() => null);
      if (record.status !== "released" && version?.webSocketDebuggerUrl === record.browserId) {
        const browser = await connect(record.browserId);
        try { await browser.send("Target.closeTarget", { targetId: record.targetId }); }
        finally { browser.close(); }
      }
      const { stopSessionRenderer } = await import("./headless.mjs");
      writeSession(path, { ...record, status: "released" });
      await stopSessionRenderer(path);
      return true;
    };
    return withProcessLock(join(dirname(path), "source-interaction.lock"), release);
  });
}
