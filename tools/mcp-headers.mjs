#!/usr/bin/env node
// Codex http_headers_helper for the proto MCP server: prints the
// auth header from ~/.proto/config.json, so the credential has one
// source on the laptop and never lives in any harness config.
import { readConfig } from "./mcp-call.mjs";

let config;
try {
  config = readConfig();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.log(JSON.stringify({ Authorization: `Bearer ${config.auth.secret}` }));
