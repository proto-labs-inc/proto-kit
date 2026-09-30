/**
 * Asking the person watching a build, on the site, and hearing back:
 * the site half of tools/questions.mjs, shared by build-stream.mjs (the
 * agent's own questions) and proto-build.mjs (the copy gate).
 *
 * A question and a laptop's answer are sent on their own, not through
 * the build's batching reporter, because the site's reply matters: a
 * question it refuses was never seen, and a default it refuses means
 * someone answered first. A site that cannot be reached is not a
 * refusal: the event is kept in the build folder like every other, and
 * the build goes on (the default still comes).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, readConfig, targetFor } from "./mcp-call.mjs";
import { awaitAnswer, markAsked, newQuestionId, questionEvent, settleAsked } from "./questions.mjs";

/** Where one event went: to the site, refused by it (with its reason), or kept in the build folder. */
async function sendAlone({ codebase, briefId, runDir, sink }, event) {
  const keep = (reason) => {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), event }) + "\n", { flag: "a" });
    return { kind: "kept", reason };
  };
  if (sink === "file") return keep("a build under test");
  let result;
  try {
    result = await callTool("report_build_events", { codebase, briefId, events: [event] });
  } catch (error) {
    return keep(error.message.split("\n")[0]);
  }
  if (result?.isError) return { kind: "refused", reason: result?.content?.[0]?.text ?? "report_build_events refused it" };
  return { kind: "sent" };
}

/** The brief's status on the site; a failure to say so is one line, never the build's end. */
async function reportProgress({ codebase, briefId, sink }, status, message) {
  if (sink === "file") return;
  try {
    // report_progress names only the brief, so the codebase picks the credential here.
    const result = await callTool("report_progress", { briefId, status, ...(message ? { message } : {}) }, targetFor(readConfig(), { codebase }));
    if (result?.isError) console.error(`… report_progress ${status}: ${result?.content?.[0]?.text ?? "refused"}`);
  } catch (error) {
    console.error(`… report_progress ${status} did not reach the site (${error.message.split("\n")[0]})`);
  }
}

/**
 * Sends the question and marks it asked; returns its id. `fields` are
 * questionEvent's without the id. Throws with the site's reason when
 * the question is refused, so the agent never waits on one nobody saw.
 */
export async function ask(build, fields) {
  const id = newQuestionId();
  const event = questionEvent({ ...fields, id });
  if (event instanceof Error) throw event;
  markAsked(build.codebase, { briefId: build.briefId, questionId: id, recommended: event.recommended, defaultAfterSeconds: event.defaultAfterSeconds });
  const sent = await sendAlone(build, event);
  if (sent.kind === "refused") {
    settleAsked(build.codebase, id);
    throw new Error(`the site refused the question: ${sent.reason}`);
  }
  if (sent.kind === "kept") console.error(`… the question is kept in the build folder (${sent.reason}); nobody on the site sees it`);
  await reportProgress(build, "needs-input", event.text);
  return id;
}

/**
 * Waits for the answer to question `questionId` (questions.mjs
 * awaitAnswer), sending the default when its countdown runs out, and
 * puts the brief back to building. Returns { by, option?, text? }.
 */
export async function waitForAnswer(build, questionId, { log = (line) => console.error(`… ${line}`) } = {}) {
  const sendDefault = async (option) => {
    const sent = await sendAlone(build, { kind: "answered", questionId, by: "default", option });
    if (sent.kind === "refused" && /already answered/i.test(sent.reason)) return "already-answered";
    if (sent.kind === "refused") log(`the site did not take the default (${sent.reason}); going with it anyway`);
    log(`Nobody answered in time: going with "${option}".`);
    return "sent";
  };
  const answer = await awaitAnswer({ codebase: build.codebase, briefId: build.briefId, questionId, sendDefault, log });
  // An answer from the site already put the brief back to building.
  if (answer.by === "default") await reportProgress(build, "building");
  return answer;
}

/** The person answered in the terminal: the site hears it as their reply, and nobody waits any more. */
export async function answeredInTerminal(build, questionId, text) {
  settleAsked(build.codebase, questionId);
  const sent = await sendAlone(build, { kind: "answered", questionId, by: "reply", text });
  if (sent.kind === "refused") throw new Error(`the site refused the answer: ${sent.reason}`);
  await reportProgress(build, "building");
  return sent;
}
