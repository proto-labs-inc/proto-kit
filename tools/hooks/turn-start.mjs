#!/usr/bin/env node
/**
 * Prompt hook (Claude Code and Codex UserPromptSubmit, Cursor
 * beforeSubmitPrompt): note when this session's turn began, in
 * <proto home>/.turns/<session>.json. At the turn's end,
 * tools/auto-publish.mjs publishes the workspaces with a file modified
 * since then, whatever modified it. Silent and fail soft: it never blocks
 * the prompt, and Cursor gets `{"continue":true}`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { turnFile } from "../auto-publish.mjs";
import { protoHome } from "../proto-home.mjs";

let cursor = false;
try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  cursor = "cursor_version" in input || "conversation_id" in input;
  const file = turnFile(protoHome(), input.session_id ?? input.conversation_id ?? input.sessionId ?? input.thread_id);
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: Date.now() }));
  }
} catch {}
if (cursor) process.stdout.write('{"continue":true}\n');
process.exit(0);
