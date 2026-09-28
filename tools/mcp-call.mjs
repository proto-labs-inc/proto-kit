/**
 * Minimal MCP-over-HTTP client for the kit's plain node processes
 * (the courier's heartbeat, publish, the prototype heartbeat; agents
 * use their harness's MCP instead) and the transport under
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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_PATH = join(process.env.HOME ?? "", ".proto", "config.json");
export const NOT_SET_UP =
  "Proto is not set up on this laptop yet: run the Proto setup skill, then try again.";
export const STALE_CREDENTIAL =
  "This laptop's Proto credential no longer works (it was removed on the Laptops page, or the account left the team): run the Proto setup skill again to link it afresh.";

/** What this laptop holds for a codebase whose team it is not linked to.
 *  Named rather than generic, because the fix is specific: link this
 *  laptop from that team's Settings. */
export function noCredentialFor(codebase, teamName) {
  const team = teamName ? `team ${teamName}` : "a team";
  return `This laptop is not linked to ${team}, which owns codebase ${codebase}: open Proto, Settings, Laptops while signed in to that team and paste the prompt it gives you.`;
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
    if (!match) throw new Error(noCredentialFor(codebase, team.name));
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
  const app = typeof config.app === "string" ? config.app.trim() : "";
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
export async function post({ app, secret }, body, sessionId) {
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
 *  explicitly for a call that has no credential yet (link_laptop). */
export async function callTool(name, args, target) {
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
  });

  const res = await post(
    target,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    init.sessionId,
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
