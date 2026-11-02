// Source tools resolve a run-owned target. URLs validate it; they never select it.
import { connect } from "./cdp.mjs";
import { resolveSourceSession } from "./source-session.mjs";

export async function listPages(port = 9333) {
  const response = await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Chrome target listing failed: ${response.status}`);
  return (await response.json()).filter(target => target.type === "page");
}

export async function findPage(url, port = 9333) {
  return resolveSourceSession(url, port);
}

export async function browser(port = 9333) {
  const response = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Chrome endpoint failed: ${response.status}`);
  return connect((await response.json()).webSocketDebuggerUrl);
}
