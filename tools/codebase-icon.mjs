#!/usr/bin/env node
/**
 * Set a codebase's icon, the favicon the website's codebase switcher
 * shows, from a file or an address:
 *
 *   node tools/codebase-icon.mjs <codebase> <file | http(s) url>
 *
 * The bytes go the way every image from this laptop goes: the app's
 * begin_codebase_icon tool signs an upload into Proto's builds bucket,
 * this process PUTs the bytes straight there, and set_codebase_icon
 * names the uploaded address on the codebase. Nothing passes through
 * the agent's context. Prints { codebase, favicon_url } on success;
 * exits 1 with one line on stderr when the icon is not usable (not a
 * png, svg or ico, or over 256 KB) or the app refuses it.
 */
import { readFileSync } from "node:fs";
import { callTool } from "./mcp-call.mjs";

const MAX_BYTES = 256 * 1024;

/** The media type the bytes are, by their content rather than a name
 *  or a server's header; null for anything the switcher cannot draw. */
export function iconContentType(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return "image/x-icon";
  }
  const head = bytes.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return "image/svg+xml";
  }
  return null;
}

async function readIcon(source) {
  if (!/^https?:\/\//.test(source)) return readFileSync(source);
  const res = await fetch(source);
  if (!res.ok) throw new Error(`${source} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function call(name, args) {
  const result = await callTool(name, args);
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

export async function setCodebaseIcon(codebase, source) {
  const bytes = await readIcon(source);
  const contentType = iconContentType(bytes);
  if (!contentType) throw new Error(`${source} is not a png, svg or ico`);
  if (bytes.length > MAX_BYTES) throw new Error(`${source} is ${bytes.length} bytes; the icon may be ${MAX_BYTES} at most`);
  const { uploadUrl, url } = await call("begin_codebase_icon", { codebase, contentType, size: bytes.length });
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!res.ok) throw new Error(`the icon upload answered ${res.status}`);
  return call("set_codebase_icon", { codebase, url });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [codebase, source] = process.argv.slice(2);
  if (!codebase || !source) {
    console.error("usage: node tools/codebase-icon.mjs <codebase> <file | http(s) url>");
    process.exit(2);
  }
  try {
    const row = await setCodebaseIcon(codebase, source);
    console.log(JSON.stringify({ codebase: row.codebase, favicon_url: row.favicon_url }));
  } catch (error) {
    console.error(`proto: codebase icon not set: ${error.message}`);
    process.exit(1);
  }
}
