#!/usr/bin/env node
/**
 * Link this laptop to a Proto account from the setup prompt's link
 * (ADR 0004): `node tools/link-laptop.mjs <app>/api/setup/<code>`.
 *
 * Fetches the setup document once, exchanges the same code for this
 * laptop's token with the app's `link_laptop` MCP tool (the one call
 * that needs no bearer), writes ~/.proto/config.json with the app
 * origin, the account and the token (mode 600), confirms with `whoami`,
 * and prints the document as JSON for the setup skill to follow. The
 * token never appears on stdout or in the conversation: it goes from
 * the app to config.json inside this process. Exit 1 with one plain
 * sentence on stderr when the link has expired or was already used.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { CONFIG_PATH, callTool } from "./mcp-call.mjs";

const link = process.argv[2];
const match = link?.match(/^(https?:\/\/[^/]+)\/api\/setup\/([A-Za-z0-9_-]+)$/);
if (!match) {
  console.error("usage: node tools/link-laptop.mjs <app>/api/setup/<code>  (the link in the setup prompt)");
  process.exit(1);
}
const [, origin, code] = match;

const fetched = await fetch(link, { headers: { Accept: "application/json" } });
const document = await fetched.json().catch(() => null);
if (!fetched.ok || !document) {
  console.error(document?.error ?? `The setup link answered ${fetched.status}.`);
  process.exit(1);
}
const app = document.app ?? origin;

const linked = unwrap(
  await callTool("link_laptop", { code, label: hostname() }, { app, secret: null }).catch((e) => ({
    content: [{ text: JSON.stringify({ error: e.message }) }],
  })),
);
if (!linked.token) {
  console.error(linked.error ?? "Linking this laptop failed.");
  process.exit(1);
}

// Keep what an earlier setup recorded that the document does not carry
// (the rig's source path, pre-npm); replace the account link outright.
let previous = {};
if (existsSync(CONFIG_PATH)) {
  try {
    previous = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    previous = {};
  }
}
const config = {
  schemaVersion: 2,
  app,
  account: { user: linked.user.id, name: linked.user.name, org: linked.org.name },
  auth: { kind: "laptop-token", secret: linked.token },
  ...(previous.packages ? { packages: previous.packages } : {}),
  createdAt: new Date().toISOString(),
};
mkdirSync(dirname(CONFIG_PATH), { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
chmodSync(CONFIG_PATH, 0o600);

const me = unwrap(await callTool("whoami", {}));
if (me.mode !== "laptop-token") {
  console.error("The laptop was linked but whoami does not recognise the credential; run setup again.");
  process.exit(1);
}
console.error(`Linked this laptop (${linked.laptop.label}) to ${me.user.name} at ${me.org.name}.`);
process.stdout.write(JSON.stringify(document, null, 2) + "\n");

/** The JSON in a tool answer's first text block. */
function unwrap(result) {
  try {
    return JSON.parse(result?.content?.[0]?.text ?? "{}");
  } catch {
    return {};
  }
}
