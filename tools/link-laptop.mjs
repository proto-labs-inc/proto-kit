#!/usr/bin/env node
/**
 * Redeem one Proto setup link without exposing the laptop token to the
 * agent. The setup document and laptop token use the same one-time code but
 * are consumed independently: fetch the document, exchange the code through
 * link_laptop, then write the token directly to ~/.proto/config.json. A
 * laptop whose config.json already holds a working token for the same app
 * and member (an Edit prompt on a laptop that is set up) keeps it: the code
 * then only served the document.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_PATH, callTool, post } from "./mcp-call.mjs";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const setupLink = process.argv[2];
if (!setupLink) fail("usage: node tools/link-laptop.mjs <setup-link>");

let link;
try {
  link = new URL(setupLink);
} catch {
  fail("the setup link is not a valid URL");
}
const code = link.pathname.split("/").filter(Boolean).at(-1);
if (!code) fail("the setup link has no linking code");

const documentResponse = await fetch(link);
const documentText = await documentResponse.text();
if (!documentResponse.ok) {
  let message = `the setup link answered ${documentResponse.status}`;
  try {
    message = JSON.parse(documentText).error ?? message;
  } catch {}
  fail(message);
}

let document;
try {
  document = JSON.parse(documentText);
} catch {
  fail("the setup link did not return a setup document");
}
const app = typeof document.app === "string" ? document.app.replace(/\/+$/, "") : "";
if (!app) fail("the setup document has no Proto app address");

// A laptop already linked to this member keeps its token.
if (existsSync(CONFIG_PATH)) {
  try {
    const current = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (current.app === app && current.auth?.secret) {
      const answer = await callTool("whoami", {});
      const me = JSON.parse(answer?.content?.[0]?.text ?? "{}");
      if (me.mode === "laptop-token" && me.user?.id === document.account?.id) {
        console.log(JSON.stringify({ setup: document, linkedAs: { user: me.user, org: me.org, laptop: me.laptop } }));
        process.exit(0);
      }
    }
  } catch {
    // Unreadable, stale or refused: link afresh below.
  }
}

const target = { app, secret: null };
const initialized = await post(target, {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "proto-kit-link", version: "0" },
  },
});
if (initialized.status >= 400) fail(`the Proto app answered ${initialized.status} while linking this laptop`);

const linkedResponse = await post(
  target,
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "link_laptop", arguments: { code, label: hostname() } },
  },
  initialized.sessionId,
);
const linkedMessage = linkedResponse.messages.find((message) => message.id === 2) ?? linkedResponse.messages[0];
const contentText = linkedMessage?.result?.content?.[0]?.text;
let linked;
try {
  linked = JSON.parse(contentText);
} catch {
  fail(contentText?.split("\n")[0] ?? `the Proto app answered ${linkedResponse.status} while linking this laptop`);
}
if (!linked.token) fail(linked.error ?? "the Proto app did not return a laptop token");

let previous = {};
if (existsSync(CONFIG_PATH)) {
  try {
    previous = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
}
const config = {
  schemaVersion: 2,
  app,
  auth: { kind: "laptop-token", secret: linked.token },
  user: linked.user,
  org: linked.org,
  laptop: linked.laptop,
  ...(previous.packages ? { packages: previous.packages } : {}),
  createdAt: new Date().toISOString(),
};
mkdirSync(dirname(CONFIG_PATH), { recursive: true });
const temporaryPath = join(dirname(CONFIG_PATH), `.config-${process.pid}.json`);
writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, CONFIG_PATH);

console.log(JSON.stringify({
  setup: document,
  linkedAs: { user: linked.user, org: linked.org, laptop: linked.laptop },
}));
