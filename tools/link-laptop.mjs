#!/usr/bin/env node
/**
 * Redeem one Proto setup link without exposing the laptop token to the
 * agent. The setup document and laptop token use the same one-time code but
 * are consumed independently: fetch the document, exchange the code through
 * link_laptop, then write the token directly to ~/.proto/config.json.
 *
 * One credential per team (MAA-195). A laptop that already holds a
 * working token for this app, member and team (an Edit prompt on a
 * laptop that is set up) keeps it: the code then only served the
 * document. A token for a team this laptop has not worked with before
 * is added beside the ones it holds; a second token for a team it
 * already holds replaces that one. Nothing else in config.json is
 * touched, so the credentials the laptop's other teams depend on
 * survive every link.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_PATH, callTool, credentialsIn, post } from "./mcp-call.mjs";

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

const previous = readPreviousConfig();
const held = previous.app === app ? credentialsIn(previous) : [];

/** What this laptop already holds, read in whichever shape the file is
 *  written in. An unreadable file is treated as nothing held. */
function readPreviousConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** A credential without its secret: what the link step may report. */
const describe = (credential) => ({
  user: credential.user,
  team: credential.team,
  laptop: credential.laptop,
  linkedAt: credential.linkedAt,
});

// A laptop already linked to this member for this team keeps that
// token. The document names the team, so only the one credential that
// could match is tried against the server.
const candidate = held.find(
  (credential) =>
    credential.user?.id === document.account?.id && credential.team?.name === document.account?.team,
);
if (candidate) {
  try {
    const answer = await callTool("whoami", {}, { app, secret: candidate.secret });
    const me = JSON.parse(answer?.content?.[0]?.text ?? "{}");
    if (me.mode === "laptop-token" && me.user?.id === document.account?.id) {
      console.log(
        JSON.stringify({
          setup: document,
          linkedAs: { user: me.user, team: me.team, laptop: me.laptop },
          added: null,
          kept: held.filter((credential) => credential !== candidate).map(describe),
        }),
      );
      process.exit(0);
    }
  } catch {
    // Stale or refused: link afresh below.
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

// The new credential joins the ones this laptop holds. A credential
// for the same team is replaced, because a team has one laptop token
// at a time; every other team's keeps working untouched.
const added = {
  kind: "laptop-token",
  secret: linked.token,
  user: linked.user,
  team: linked.team,
  laptop: linked.laptop,
  linkedAt: new Date().toISOString(),
};
const kept = held.filter((credential) => credential.team?.id !== added.team?.id);
const config = {
  schemaVersion: 3,
  app,
  credentials: [...kept, added],
  ...(previous.packages ? { packages: previous.packages } : {}),
  createdAt: previous.createdAt ?? added.linkedAt,
  updatedAt: added.linkedAt,
};
mkdirSync(dirname(CONFIG_PATH), { recursive: true });
const temporaryPath = join(dirname(CONFIG_PATH), `.config-${process.pid}.json`);
writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, CONFIG_PATH);

console.log(JSON.stringify({
  setup: document,
  linkedAs: { user: linked.user, team: linked.team, laptop: linked.laptop },
  added: describe(added),
  kept: kept.map(describe),
}));
