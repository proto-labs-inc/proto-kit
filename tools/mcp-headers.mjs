#!/usr/bin/env node
// Codex http_headers_helper for the proto MCP server: prints the
// auth header from ~/.proto/config.json, so the credential has one
// source on the laptop and never lives in any harness config.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(
  readFileSync(join(process.env.HOME ?? "", ".proto", "config.json"), "utf8"),
);
console.log(JSON.stringify({ Authorization: `Bearer ${config.auth.secret}` }));
