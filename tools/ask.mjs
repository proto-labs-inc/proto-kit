/** Durable chat questions with bounded best-effort outbound history and progress. */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReporter } from "./build-report.mjs";
import { callTool, readConfig, targetFor } from "./mcp-call.mjs";
import { answerChatQuestion, chatAnswer, keepChatQuestion, needsChatInput, readChatQuestion } from "./chat-questions.mjs";

export const CHAT_PROGRESS_TIMEOUT_MS = 15_000;

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

async function boundedCall(name, args, target) {
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    const error = new Error("Outbound update timed out"); error.name = "TimeoutError";
    controller.abort(error); reject(error);
  }, CHAT_PROGRESS_TIMEOUT_MS); });
  try { return await Promise.race([callTool(name, args, target, { signal: controller.signal }), timeout]); }
  finally { clearTimeout(timer); }
}
/** Question history shares the regular durable outbox; answers follow questions. */
async function deliverHistory(build, pending) {
  if (build.sink === "file") return;
  const target = build.progressTarget ?? targetFor(readConfig(), { codebase: build.codebase });
  const reporter = createReporter({ ...build, transport: (name, args) =>
    boundedCall(name, args, target) });
  for (const { event, marker } of pending) {
    // A durable key makes a restart between queueing and acknowledgment harmless.
    reporter.send([event], { key: `${event.kind}-${event.id ?? event.questionId}` });
    await reporter.flush();
    writeFileSync(marker, "reported\n");
  }
  await reporter.flush();
}
export async function flushQuestionHistory(build) {
  const dir = join(build.runDir, "questions");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter(name => /^q-[a-z0-9-]+\.json$/.test(name)).sort()) {
    const id = file.slice(0, -5);
    await deliverHistory(build, history(build, id, chatAnswer(build, id)));
  }
}
async function reportState(build, { status, message, pending }) {
  if (build.sink === "file") return;
  try {
    await deliverHistory(build, pending);
    if (status) {
      const target = build.progressTarget ?? targetFor(readConfig(), { codebase: build.codebase });
      const result = await boundedCall("report_progress", { briefId: build.briefId, status, ...(message ? { message } : {}) }, target);
      if (result.isError) throw new Error(result.content?.[0]?.text ?? "Progress refused");
    }
  } catch (error) { console.error(`Outbound update pending: ${error.message.split("\n")[0]}`); }
}

export async function ask(build, fields) {
  const workflowPath = join(build.runDir, "workflow.json");
  const workflow = existsSync(workflowPath) ? JSON.parse(readFileSync(workflowPath, "utf8")) : null;
  const id = keepChatQuestion(build, { ...fields, ...(workflow ? { step: workflow.step } : {}) });
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
