/** Durable chat questions with bounded best-effort outbound history and progress. */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callTool, readConfig, targetFor } from "./mcp-call.mjs";
import { answerChatQuestion, chatAnswer, keepChatQuestion, needsChatInput, readChatQuestion } from "./chat-questions.mjs";

export const CHAT_PROGRESS_TIMEOUT_MS = 1_000;

function history(build, questionId, answer = null) {
  const question = readChatQuestion(build, questionId).question;
  const events = [question, ...(answer ? [{ kind: "answered", questionId, ...answer }] : [])];
  return events.map((event) => {
    const base = join(build.runDir, "questions", `${questionId}.${event.kind}`);
    try {
      writeFileSync(base + ".event.json", JSON.stringify(event) + "\n", { flag: "wx" });
      appendFileSync(join(build.runDir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), event }) + "\n");
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    return { event, marker: base + ".sent" };
  }).filter(({ marker }) => !existsSync(marker));
}

/** Both outbound requests share a single deadline; neither is an input channel. */
async function reportState(build, { status, message, pending }) {
  if (build.sink === "file" || (!status && pending.length === 0)) return;
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("outbound update timed out");
      controller.abort(error);
      reject(error);
    }, CHAT_PROGRESS_TIMEOUT_MS);
  });
  try {
    const target = build.progressTarget ?? targetFor(readConfig(), { codebase: build.codebase });
    const requests = [];
    if (status) requests.push(callTool("report_progress", { briefId: build.briefId, status, ...(message ? { message } : {}) }, target, { signal: controller.signal }));
    if (pending.length) requests.push((async () => {
      // Cloud accepts each answer on its own, after its question exists.
      // Offline retries must deliver the question first, not a mixed batch.
      for (const { event, marker } of pending) {
        if (controller.signal.aborted) return;
        const result = await callTool("report_build_events", { codebase: build.codebase, briefId: build.briefId, events: [event] }, target, { signal: controller.signal });
        if (result?.isError) return result;
        writeFileSync(marker, "reported\n");
      }
    })());
    const results = await Promise.race([deadline, Promise.allSettled(requests)]);
    if (results.some((result) => result.status === "rejected" || result.value?.isError)) console.error("… the site did not accept every update; local question history is preserved");
  } catch (error) {
    console.error(`… outbound update did not reach the site (${error.message.split("\n")[0]}); local question history is preserved`);
  } finally { clearTimeout(timer); }
}

export async function ask(build, fields) {
  const id = keepChatQuestion(build, fields);
  const answer = chatAnswer(build, id);
  await reportState(build, { ...(answer ? {} : { status: "needs-input", message: "Waiting for an answer in the agent conversation." }), pending: history(build, id, answer) });
  return id;
}

/** Read the durable answer or return needs-input immediately; never poll or default. */
export async function waitForAnswer(build, questionId) {
  return chatAnswer(build, questionId) ?? needsChatInput(build, questionId);
}

export async function answeredInTerminal(build, questionId, input) {
  const fields = typeof input === "string" ? { text: input } : input;
  const previous = chatAnswer(build, questionId);
  const answer = answerChatQuestion(build, questionId, fields);
  // A replay can retry unsent history, but must not clear a later question's status.
  await reportState(build, { ...(previous ? {} : { status: "building" }), pending: history(build, questionId, answer) });
  return answer;
}
