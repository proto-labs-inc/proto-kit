#!/usr/bin/env node
// Durable questions for a build or variant brief, answered in the active
// conversation and mirrored to the Proto site through the brief's build
// stream (report_build_events). The record lives in
// ~/.proto/<codebase>/run/builds/<briefId>/questions/.
//
// Usage:
//   node tools/build-stream.mjs question <briefId> --codebase <id> --kind copy-gate|generic "<question>"
//                                [--detail "…"] [--impact "…"] --option id="Label" --option id="Label" [--option …]
//                                [--recommended <id>] [--suggest "…"]…
//                                [--copied <0-100>] [--missing <nodeId>,…]
//       prints a needs-input JSON record, or the already-persisted answer
//   node tools/build-stream.mjs await-answer <briefId> <questionId> --codebase <id>
//       reads the durable answer or returns needs-input immediately
//       { by: option|reply, option?, text? }
//   node tools/build-stream.mjs answered <briefId> <questionId> --codebase <id> --text "<what they said>" | --option <id>
//       records the answer from the current conversation
// Questions return promptly and never select a default answer.
// --question-key <stable-key> distinguishes repeated identical chat questions.
// Every command takes --no-send: events go to <build>/events.jsonl instead
// of the site (a build under test).
import { join } from "node:path";
import { answeredInTerminal, ask, waitForAnswer } from "./ask.mjs";
import { protoHome } from "./proto-home.mjs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Flags a command takes more than once: each one adds to a list.
const REPEATED = new Set(["option", "suggest"]);

function parseArgs(argv) {
  const positional = [];
  const flags = { option: [], suggest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-send") flags.noSend = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (REPEATED.has(key)) flags[key].push(argv[i + 1]);
      else flags[key] = argv[i + 1];
      i++;
    } else positional.push(arg);
  }
  return { positional, flags };
}

/** "id=Label" -> { id, label }. */
function optionOf(spec) {
  const at = spec?.indexOf("=") ?? -1;
  if (at <= 0) fail(`--option takes id="Label", not ${spec}`);
  return { id: spec.slice(0, at), label: spec.slice(at + 1) };
}

/** A numeric flag, or undefined when it was not given. */
function numberFlag(name) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) fail(`--${name} takes a number, not ${flags[name]}`);
  return value;
}

const [command, briefId, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);
if (!command || !briefId) fail("usage: node tools/build-stream.mjs <command> <briefId> --codebase <id> ...");
const codebase = flags.codebase;
if (!codebase) fail("--codebase is required: it chooses this laptop's credential for the build");

const runDir = join(protoHome(), codebase, "run", "builds", briefId);
const sink = flags.noSend ? "file" : "site";
const build = { codebase, briefId, runDir, sink, questionKey: flags["question-key"] };

switch (command) {
  case "question": {
    const [text] = positional;
    if (!text) fail("question needs the question");
    if (!flags.kind) fail("question needs --kind copy-gate or --kind generic");
    const fields = {
      form: flags.kind,
      text,
      detail: flags.detail,
      impact: flags.impact,
      options: flags.option.map(optionOf),
      recommended: flags.recommended,
      suggestions: flags.suggest,
      copied: numberFlag("copied"),
      missing: flags.missing === undefined ? undefined : flags.missing.split(",").map((id) => id.trim()).filter(Boolean),
    };
    const questionId = await ask(build, fields).catch((error) => fail(error.message));
    console.log(JSON.stringify(await waitForAnswer(build, questionId)));
    break;
  }
  case "await-answer": {
    const [questionId] = positional;
    if (!questionId) fail("await-answer needs the question id `question` printed");
    const answer = await waitForAnswer(build, questionId).catch((error) => fail(error.message));
    console.log(JSON.stringify(answer));
    break;
  }
  case "answered": {
    const [questionId] = positional;
    if (!questionId || (flags.text !== undefined) === (flags.option.length > 0) || flags.option.length > 1) fail('answered needs the question id and exactly one --text "<what the person said>" or --option <id>');
    const answer = await answeredInTerminal(build, questionId, flags.option.length ? { option: flags.option[0] } : { text: flags.text }).catch((error) => fail(error.message));
    console.log(JSON.stringify(answer));
    break;
  }
  default:
    fail(`unknown command ${command}`);
}
