/**
 * The beat loop of prototype-heartbeat.mjs (a prototype's or the
 * library's serving run). Every beat is one call of the app's
 * `heartbeat` tool with a target that says what is being served:
 * { kind: "prototype", codebase, slug } or { kind: "library",
 * codebase }; the identity comes from ~/.proto/config.json's laptop token. The app owns the cadence:
 * the tool answers with `staleAfterSeconds`, the silence after which
 * it treats the laptop as gone, and this loop beats at a third of that
 * window, so the app still sees a beat inside it when one goes
 * missing. Only the first beat is sent before any answer exists; from
 * then on the interval is the app's. A beat that fails, or that the
 * caller skips because serving is not healthy, keeps the last window
 * learned and never crashes the process: staleness is the signal, and
 * a beat that cannot be sent is a missed beat.
 */
import { callTool } from "./mcp-call.mjs";

/** Between tries while the app has not yet answered with its window. */
const RETRY_BEFORE_FIRST_ANSWER_MS = 5_000;

/**
 * Beat forever. `targetNow` answers, for each beat, the target to send
 * (or null to skip this beat); it may throw.
 */
export function beatForever(targetNow) {
  let staleAfterSeconds = null;
  const tick = async () => {
    try {
      const window = windowOf(await sendBeat(targetNow()));
      if (window !== null) staleAfterSeconds = window;
    } catch (e) {
      console.log(`heartbeat not sent (${e.message}); still beating`);
    }
    let delay = RETRY_BEFORE_FIRST_ANSWER_MS;
    if (staleAfterSeconds !== null) delay = (staleAfterSeconds * 1000) / 3;
    setTimeout(tick, delay);
  };
  tick();
}

/** One call of the heartbeat tool for `target`, or null when there is nothing to send. */
function sendBeat(target) {
  if (target === null) return null;
  return callTool("heartbeat", target);
}

/** The `staleAfterSeconds` in the heartbeat tool's answer (JSON in content[0].text), or null. */
function windowOf(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    const answer = JSON.parse(text);
    if (typeof answer.staleAfterSeconds === "number" && answer.staleAfterSeconds > 0) {
      return answer.staleAfterSeconds;
    }
  } catch {}
  return null;
}
