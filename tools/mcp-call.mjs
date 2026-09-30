/**
 * Minimal MCP-over-HTTP client for the kit's plain node processes
 * (the courier fetching its relay address, publish, the prototype
 * heartbeat; agents use their harness's MCP instead) and the transport under
 * mcp-stdio.mjs, the Cursor plugin's stdio bridge. Speaks just enough
 * Streamable HTTP: POST one JSON-RPC message, carry the session header
 * when the server issues one, read answers that come as plain JSON or
 * as SSE frames. `readConfig` is the one reader of
 * ~/.proto/config.json for every kit process.
 *
 * A laptop holds one credential per team, because a team is what a
 * token is minted against and a person's teams are reached by separate
 * addresses that the server can never know belong to one human. So
 * `callTool` picks the credential by the codebase it is acting on:
 * codebase, to team, to credential. Tools that name no codebase
 * (`whoami`, `link_laptop`) use the only credential, or the most
 * recently linked when there are several.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONFIG_PATH = join(process.env.HOME ?? "", ".proto", "config.json");
export const NOT_SET_UP =
  "Proto is not set up on this laptop yet: run the Proto setup skill, then try again.";
export const STALE_CREDENTIAL =
  "This laptop's Proto credential no longer works (it was removed on the Laptops page, or the account left the team): run the Proto setup skill again to link it afresh.";

/** This laptop holds no credential for a team it is being asked to act
 *  in. A local diagnosis, not a server refusal: nothing was asked of
 *  the server and nothing is wrong with the credentials held. It lives
 *  here so every caller says it the same way, whichever way that
 *  caller would go on to obtain one. */
export function noCredentialFor({ team, codebase } = {}) {
  const which = team ? `team ${team}` : "that team";
  const owns = codebase ? `, which owns codebase ${codebase}` : "";
  return `This laptop is not linked to ${which}${owns}: open Proto, Settings, Laptops while signed in to that team and paste the prompt it gives you.`;
}

/** The credentials a config file holds, newest link last, whichever
 *  shape it is written in. A file from the previous kit holds one under
 *  `auth` and is read as a single entry; it is never rewritten here, so
 *  a laptop that is already working keeps working untouched. */
export function credentialsIn(config) {
  if (Array.isArray(config.credentials)) {
    return config.credentials.filter((c) => typeof c?.secret === "string" && c.secret.length > 0);
  }
  if (config.auth?.kind === "laptop-token" && typeof config.auth.secret === "string" && config.auth.secret.length > 0) {
    return [
      {
        secret: config.auth.secret,
        user: config.user,
        // `org` is what the kit wrote before the rename; a laptop
        // linked back then still names its team that way.
        team: config.team ?? config.org,
        laptop: config.laptop,
        linkedAt: config.createdAt,
      },
    ];
  }
  return [];
}

/** The team a codebase belongs to, as the laptop recorded it, or null.
 *  Written at setup and confirmed by the first call that succeeds for
 *  it, so a codebase set up by an older kit learns its team the first
 *  time a credential works for it. */
export function codebaseTeam(codebase) {
  try {
    const record = JSON.parse(readFileSync(codebaseRecordPath(codebase), "utf8"));
    return record.team?.id ? record.team : null;
  } catch {
    return null;
  }
}

function codebaseRecordPath(codebase) {
  return join(process.env.HOME ?? "", ".proto", codebase, "codebase.json");
}

/** Record which team a codebase belongs to, once a credential for that
 *  team has actually been accepted for it. Silent when the file is
 *  missing: a codebase with no record on this laptop is not an error. */
export function rememberCodebaseTeam(codebase, team) {
  if (!codebase || !team?.id) return;
  const path = codebaseRecordPath(codebase);
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }
  if (record.team?.id === team.id) return;
  writeFileSync(path, `${JSON.stringify({ ...record, team }, null, 2)}\n`);
}

/** The credential to act with, and why it was the one. `codebase`
 *  picks by the team that owns it, as this laptop recorded it. With no
 *  codebase, or none recorded for it yet, the only credential is used,
 *  or the most recently linked — a guess, so `why` is "newest" and
 *  every caller says which team it acted as. */
export function pickCredential(config, { codebase } = {}) {
  const credentials = config.credentials;
  if (credentials.length === 0) throw new Error(NOT_SET_UP);
  const team = codebase ? codebaseTeam(codebase) : null;
  if (team) {
    const match = credentials.find((c) => c.team?.id === team.id);
    if (!match) throw new Error(noCredentialFor({ team: team.name, codebase }));
    return { credential: match, why: "codebase" };
  }
  if (credentials.length === 1) return { credential: credentials[0], why: "only" };
  const newest = credentials.reduce((a, c) => ((c.linkedAt ?? "") > (a.linkedAt ?? "") ? c : a));
  return { credential: newest, why: "newest" };
}

/** The credential alone, for callers with nothing to say about it. */
export function credentialFor(config, options) {
  return pickCredential(config, options).credential;
}

/** What a caller says when it had to guess which team to act as. */
export function actingAs(codebase, credential) {
  const what = codebase ? `codebase ${codebase} names no team on this laptop` : "no codebase was named";
  return `proto: ${what}; acting as the most recently linked team, ${credential.team?.name ?? "unknown"}.`;
}

/** A credential without its secret: what a caller may report. */
export const describeCredential = (credential) => ({
  user: credential.user,
  team: credential.team,
  laptop: credential.laptop,
  linkedAt: credential.linkedAt,
});

/** Add a credential to the set this laptop holds, replacing only one
 *  for the same team, and write the file back with mode 600.
 *
 *  Its own operation on purpose. A credential is a credential however
 *  it was obtained — exchanged for a pasted code, or handed over after
 *  a person approved the request in a browser — so no way of obtaining
 *  one owns this file or is recorded in an entry. A file in an older
 *  shape is carried over here, at the moment something is added to it,
 *  and never merely by being read.
 *
 *  Returns what was added and what was kept, without secrets. */
export function addCredential({ app, credential }) {
  let previous = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      previous = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      previous = {}; // unreadable: this credential starts the file afresh
    }
  }
  const held = previous.app === app ? credentialsIn(previous) : [];
  const kept = held.filter((held) => held.team?.id !== credential.team?.id);
  const replaced = held.find((held) => held.team?.id === credential.team?.id) ?? null;
  const config = {
    schemaVersion: 3,
    app,
    credentials: [...kept, credential],
    createdAt: previous.createdAt ?? credential.linkedAt,
    updatedAt: credential.linkedAt,
  };
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const temporaryPath = join(dirname(CONFIG_PATH), `.config-${process.pid}.json`);
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, CONFIG_PATH);
  return {
    added: describeCredential(credential),
    replaced: replaced ? describeCredential(replaced) : null,
    kept: kept.map(describeCredential),
  };
}

/** One sentence for what a link did: what this laptop can now do, and
 *  what it could already do and still can. Never promises that linking
 *  is done with — a person links once per team, and the point of the
 *  set is that doing so costs them nothing they already had.
 *
 *  Here beside `addCredential` because it describes the set, not the
 *  way a credential arrived; a credential approved in a browser leaves
 *  the same thing to say as a pasted one. */
export function summarizeLink({ added = null, replaced = null, unchanged = null, kept = [] } = {}) {
  const as = (credential) =>
    `${credential.user?.email ?? credential.user?.name ?? "this laptop"} in ${credential.team?.name ?? "an unnamed team"}`;
  const clauses = [];
  if (added && replaced) clauses.push(`Relinked as ${as(added)}, replacing the previous credential for that team`);
  else if (added) clauses.push(`Linked as ${as(added)}`);
  else if (unchanged) clauses.push(`Already linked as ${as(unchanged)}`);
  if (kept.length > 0) clauses.push(`still linked as ${inWords(kept.map(as))}`);
  return clauses.length === 0 ? "" : `${clauses.join("; ")}.`;
}

/** "a", "a and b", "a, b and c". */
function inWords(items) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The endpoint and bearer for one call. */
export function targetFor(config, options) {
  return { app: config.app, secret: credentialFor(config, options).secret };
}

/**
 * ~/.proto/config.json, the laptop link setup writes (shape in
 * skills/setup). A file that is missing, unreadable, or holding no
 * usable credential throws NOT_SET_UP, so every kit process answers
 * "not set up yet" with the same sentence. `app` comes back without a
 * trailing slash and `credentials` is always a list, whichever shape
 * the file is written in.
 */
export function readConfig() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    throw new Error(NOT_SET_UP);
  }
  // PROTO_APP points the kit at another deployment of the site (a branch
  // under test) without touching the laptop's link: same credentials, other
  // address. Unset, the linked site is used.
  const override = process.env.PROTO_APP?.trim();
  const app = override || (typeof config.app === "string" ? config.app.trim() : "");
  const credentials = credentialsIn(config);
  if (app.length === 0 || credentials.length === 0) throw new Error(NOT_SET_UP);
  return { ...config, app: app.replace(/\/+$/, ""), credentials };
}

/** Every JSON-RPC message in a response body: plain JSON or SSE frames. */
export function parseMessages(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const messages = [];
  for (const frame of trimmed.split(/\n\n+/)) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data.length === 0) continue;
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  return messages;
}

/**
 * POST one JSON-RPC message to the app's MCP endpoint. Returns the
 * HTTP status, the session id the server issued (if any), and the
 * parsed messages of a successful answer (empty for 202 or errors).
 * `secret` is the laptop token, sent as the bearer; null sends none,
 * which only link_laptop accepts.
 */
export async function post({ app, secret }, body, sessionId, { signal } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(`${app}/api/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    messages: res.ok ? parseMessages(text) : [],
    text,
  };
}

/** Call one tool as this laptop (the target from config.json), or, with
 *  an explicit target, as whoever that says: link_laptop is called with
 *  { app, secret: null } before config.json exists. Throws on a JSON-RPC
 *  error and on 401, with the sentence the setup skill tells the user. */
/** Call one tool. The credential is chosen by the codebase in `args`,
 *  so a laptop linked to several teams acts as the right member without
 *  anything upstream knowing they are the same person. Pass `target`
 *  explicitly for a call that has no credential yet (link_laptop).
 *  `signal` bounds the call for a caller that retries on its own. */
export async function callTool(name, args, target, { signal } = {}) {
  let chosen = null;
  if (!target) {
    const config = readConfig();
    const pick = pickCredential(config, { codebase: args?.codebase });
    chosen = pick.credential;
    if (pick.why === "newest") console.error(actingAs(args?.codebase, chosen));
    target = { app: config.app, secret: chosen.secret };
  }
  const init = await post(target, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "proto-kit", version: "0" },
    },
  }, undefined, { signal });

  const res = await post(
    target,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    init.sessionId,
    { signal },
  );
  if (res.status === 401) throw new Error(STALE_CREDENTIAL);
  const body = res.messages.find((m) => m.id === 2) ?? res.messages[0];
  if (!body) throw new Error(`${name}: the Proto app answered ${res.status}`);
  if (body.error) throw new Error(`${name}: ${body.error.message ?? JSON.stringify(body.error)}`);
  // The call was accepted, so this credential's team owns this codebase.
  // Recording it is what lets a codebase from an older kit route on its
  // own from here on.
  if (chosen?.team && args?.codebase) rememberCodebaseTeam(args.codebase, chosen.team);
  return body.result;
}
