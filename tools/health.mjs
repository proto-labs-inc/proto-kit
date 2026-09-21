#!/usr/bin/env node
/**
 * Read-only health check across ~/.proto — the proto plugin's
 * session-start hook. One line per product: what's serving and whether
 * the courier is listening, with the one command that fixes it when
 * something's down. Never restarts anything, never errors: a machine
 * with no ~/.proto prints nothing and exits 0.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(process.env.HOME ?? "", ".proto");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

let products;
try {
  products = readdirSync(root, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name !== "chrome",
  );
} catch {
  process.exit(0); // no ~/.proto: not set up, nothing to say
}

for (const product of products) {
  const runRoot = join(root, product.name, "run");
  let runDirs = [];
  try {
    runDirs = readdirSync(runRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {}
  if (runDirs.length === 0) continue; // nothing ever served: stay quiet

  let servingUp = 0;
  let servingTotal = 0;
  let courier = null; // null = not set up, true/false = listening or not
  for (const dir of runDirs) {
    const state = readJson(join(runRoot, dir.name, "state.json"));
    const up =
      state !== null &&
      alive(state.pid) &&
      Object.values(state.processes).every((p) => alive(p.pid));
    if (dir.name === "courier") courier = up;
    else {
      servingTotal += 1;
      if (up) servingUp += 1;
    }
  }

  const parts = [];
  if (servingTotal > 0)
    parts.push(
      servingUp === servingTotal
        ? "serving"
        : `${servingUp}/${servingTotal} serving`,
    );
  if (courier !== null) parts.push(courier ? "courier listening" : "courier offline");
  const allGood =
    (servingTotal === 0 || servingUp === servingTotal) && courier !== false;
  console.log(
    allGood
      ? `${product.name}: ${parts.join(", ")}`
      : `${product.name}: ${parts.join(", ")} — run /proto:serve to bring it back`,
  );
}
