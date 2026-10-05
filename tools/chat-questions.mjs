/** Durable, non-blocking questions answered in the current agent conversation. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { questionEvent } from "./questions.mjs";

function questionPath(build, id) {
  if (!/^q-[a-z0-9-]{1,38}$/.test(id)) throw new Error("invalid question id");
  return join(build.runDir, "questions", `${id}.json`);
}

/** The same question/checkpoint keeps its id across invocations, including after an answer. */
export function keepChatQuestion(build, fields) {
  const event = questionEvent({ ...fields, id: "q-validate" });
  if (event instanceof Error) throw event;
  delete event.id;
  const identity = build.questionKey === undefined ? event : { key: build.questionKey };
  const id = `q-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
  const path = questionPath(build, id);
  const record = { briefId: build.briefId, codebase: build.codebase, question: { ...event, id } };
  mkdirSync(join(build.runDir, "questions"), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = readChatQuestion(build, id);
    if (JSON.stringify(existing.question) !== JSON.stringify(record.question)) throw new Error(`question key ${build.questionKey} already names a different question`);
  }
  return id;
}

export function hasChatQuestion(build, id) {
  return existsSync(questionPath(build, id));
}

export function readChatQuestion(build, id) {
  const path = questionPath(build, id);
  if (!existsSync(path)) throw new Error(`no chat question ${id} in this build`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (record.briefId !== build.briefId || record.codebase !== build.codebase) throw new Error("question belongs to a different build");
  return record;
}

export function chatAnswer(build, id) {
  readChatQuestion(build, id);
  const path = questionPath(build, id).replace(/\.json$/, ".answer.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function needsChatInput(build, id) {
  const { question } = readChatQuestion(build, id);
  return { status: "needs-input", stop: "needs-input", interaction: "chat", briefId: build.briefId, codebase: build.codebase, questionId: id, question, message: "Waiting for an answer in this conversation. Record the answer with build-stream answered, then resume the original command." };
}

/** An exclusive answer file makes retries harmless and rejects a different second answer. */
export function answerChatQuestion(build, id, input) {
  const { question } = readChatQuestion(build, id);
  if (!input || (input.option !== undefined) === (input.text !== undefined)) throw new Error("answer needs exactly one of --option or --text");
  let answer;
  if (input.option !== undefined) {
    if (!question.options.some((option) => option.id === input.option)) throw new Error(`unknown option ${input.option}; choose ${question.options.map((option) => option.id).join(", ")}`);
    answer = { by: "option", option: input.option };
  } else {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 500) throw new Error("answer text must be 1 to 500 characters");
    answer = { by: "reply", text: input.text.trim() };
  }
  const path = questionPath(build, id).replace(/\.json$/, ".answer.json");
  try {
    writeFileSync(path, JSON.stringify(answer, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = chatAnswer(build, id);
    if (JSON.stringify(previous) !== JSON.stringify(answer)) throw new Error(`question ${id} already has a different answer`);
  }
  return answer;
}
