#!/usr/bin/env node
/** Report a setup blocker through the same authenticated MCP contract as the agent. */
import { callTool } from "./mcp-call.mjs";

const [codebase, message] = process.argv.slice(2);
if (!codebase || !message?.trim()) {
  console.error("Usage: setup-action.mjs <codebase> <message>, or <codebase> clear");
  process.exit(1);
}
try {
  const result = await callTool("report_setup_action", {
    codebase,
    action: message === "clear" ? null : { message },
  });
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text);
  console.log(text);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
