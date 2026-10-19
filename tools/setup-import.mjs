#!/usr/bin/env node
import { callTool } from "./mcp-call.mjs";
const [codebase, status, error] = process.argv.slice(2);
try {
  if (!codebase || !["importing", "failed"].includes(status) || (status === "failed" && !error?.trim()))
    throw new Error("Usage: setup-import.mjs <codebase> importing | failed <error>");
  const report = status === "failed" ? { status, error } : { status };
  const result = await callTool("report_design_system_import", { codebase, report });
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text);
  console.log(text);
} catch (error) { console.error(error.message); process.exitCode = 1; }
