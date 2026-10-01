#!/usr/bin/env node
/**
 * Redeem the one-time linking code in an embedded Proto setup document
 * without exposing the laptop token to the agent. Exchange linkingCode
 * through link_laptop, then write the token directly to
 * ~/.proto/config.json.
 *
 * One credential per team (MAA-195). A laptop that already holds a
 * working token for this app, member and team (an Edit prompt on a
 * laptop that is set up) keeps it, without spending the code. Otherwise
 * the token this code was exchanged for is handed
 * to `addCredential`, which owns config.json. This file is one way of
 * obtaining a credential, not the owner of the set.
 */
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  CONFIG_PATH,
  addCredential,
  callTool,
  credentialsIn,
  describeCredential,
  post,
  summarizeLink,
} from "./mcp-call.mjs";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const [, , appInput, code, accountId] = process.argv;
if (!appInput || !code || !accountId) {
  fail("usage: node tools/link-laptop.mjs <app> <linking-code> <account-id>");
}

let app;
try {
  const address = new URL(appInput);
  if (address.protocol !== "http:" && address.protocol !== "https:") throw new Error("unsupported protocol");
  app = address.origin;
} catch {
  fail("the setup document has an invalid Proto app address");
}

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

// Account ids are unique member rows, so at most one held credential can
// belong to the member and team named by this document.
const candidate = held.find((credential) => credential.user?.id === accountId);
if (candidate) {
  try {
    const answer = await callTool("whoami", {}, { app, secret: candidate.secret });
    const me = JSON.parse(answer?.content?.[0]?.text ?? "{}");
    if (me.mode === "laptop-token" && me.user?.id === accountId) {
      const unchanged = describeCredential({ ...candidate, user: me.user, team: me.team, laptop: me.laptop });
      const kept = held.filter((credential) => credential !== candidate).map(describeCredential);
      console.log(
        JSON.stringify({
          linkedAs: { user: me.user, team: me.team, laptop: me.laptop },
          added: null,
          replaced: null,
          kept,
          summary: summarizeLink({ unchanged, kept }),
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

// The token joins the set, replacing only a credential for the same
// team. Where it came from is this file's business; the set's shape
// and the write are not.
const { added, replaced, kept } = addCredential({
  app,
  credential: {
    kind: "laptop-token",
    secret: linked.token,
    user: linked.user,
    team: linked.team,
    laptop: linked.laptop,
    linkedAt: new Date().toISOString(),
  },
});

console.log(JSON.stringify({
  linkedAs: { user: linked.user, team: linked.team, laptop: linked.laptop },
  added,
  replaced,
  kept,
  summary: summarizeLink({ added, replaced, kept }),
}));
