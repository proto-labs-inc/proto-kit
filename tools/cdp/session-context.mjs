// Explicit session paths propagate to child tools through their environment.
import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { protoHome } from "../proto-home.mjs";

export function browserSessionPath() {
  const index = process.argv.indexOf("--browser-session");
  const path = index >= 0 ? process.argv[index + 1] : process.env.PROTO_BROWSER_SESSION;
  return path ? resolve(path) : null;
}
export function buildSessionPath(codebase, runId) {
  for (const value of [codebase, runId]) {
    if (!value || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid browser-session build identity");
  }
  return join(protoHome(), codebase, "run", "builds", runId, "browser-session.json");
}
export function useBuildSession(codebase, runId) {
  const path = buildSessionPath(codebase, runId);
  process.env.PROTO_BROWSER_SESSION = path;
  return path;
}
export function readSession(path = browserSessionPath()) {
  if (!path) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function writeSession(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, path);
}
export function sourceIdentity() {
  const record = readSession();
  if (!record) return null;
  return `${record.browserId}:${record.targetId}:${record.generation}`;
}

export function browserArguments() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--browser-session");
  if (index >= 0) args.splice(index, 2);
  return args;
}
