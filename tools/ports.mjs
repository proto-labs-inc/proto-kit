import { writeSession } from "./cdp/session-context.mjs";
import { existsSync } from "node:fs";
import { withProcessLock } from "./process-lock.mjs";
/**
 * Ports for the kit's dev servers, chosen so two of them never share
 * one. Two things went wrong before this file: a port was probed on
 * 127.0.0.1 only, while Vite binds localhost as ::1 on a Mac, so a
 * port another prototype was serving on looked free and the new
 * build's every check hit the other app; and a build looked at its
 * own codebase's workspaces only, while ~/.proto holds several.
 *
 *   await portIsFree(port)      nothing bound on either loopback address
 *   claimedPorts()              every port a record under ~/.proto names
 *   await pickPort({ from, to })   the lowest free, unclaimed port in a range
 *   await ephemeralPort()       a free port the system picks, checked on both addresses
 */
import { readdirSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { protoHome } from "./proto-home.mjs";

const PROTO = protoHome();
const LOOPBACKS = ["127.0.0.1", "::1"];

/** Whether `port` can be bound on both loopback addresses and nothing answers a connection on either. */
export async function portIsFree(port) {
  for (const host of LOOPBACKS) {
    if (await answers(port, host)) return false;
    if (!(await bindable(port, host))) return false;
  }
  return true;
}

/**
 * Every port recorded under ~/.proto, for every codebase: each
 * workspace's public/prototype.json, each run spec's PROTO_PORT and
 * each library's local.json (tunnel.json for a run an older kit
 * started). A record may be stale (its server is
 * down) and still counts: it is that prototype's port to come back to.
 */
export function claimedPorts() {
  const claimed = new Set();
  const readJson = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };
  const dirs = (path) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
    } catch {
      return [];
    }
  };
  for (const codebase of dirs(PROTO)) {
    for (const workspace of dirs(join(codebase, "prototypes"))) {
      const port = readJson(join(workspace, "public", "prototype.json"))?.port;
      if (Number.isInteger(port)) claimed.add(port);
    }
    for (const index of dirs(join(codebase, "screens", "work"))) {
      for (const version of dirs(index)) {
        for (const workspace of dirs(version)) {
          const port = readJson(join(workspace, "public", "prototype.json"))?.port;
          if (Number.isInteger(port)) claimed.add(port);
        }
      }
    }
    for (const run of dirs(join(codebase, "run"))) {
      const spec = readJson(join(run, "spec.json"));
      for (const process of spec?.processes ?? []) {
        const port = Number(process.env?.PROTO_PORT);
        if (Number.isInteger(port) && port > 0) claimed.add(port);
      }
      for (const record of ["local.json", "tunnel.json"]) {
        const port = readJson(join(run, record))?.port;
        if (Number.isInteger(port)) claimed.add(port);
      }
    }
  }
  return claimed;
}

/**
 * The port a codebase's library run serves on, from the record
 * host-library.mjs writes (run/library/local.json; tunnel.json for a run
 * an older kit started), or null when the library has never been served.
 */
export function libraryPort(codebase) {
  for (const record of ["local.json", "tunnel.json"]) {
    try {
      const port = JSON.parse(readFileSync(join(PROTO, codebase, "run", "library", record), "utf8")).port;
      if (Number.isInteger(port)) return port;
    } catch {}
  }
  return null;
}

/**
 * The lowest port in [from, to) that no record under ~/.proto claims
 * and nothing on this laptop holds.
 */
export async function pickPort({ from = 5200, to = 5400 } = {}) {
  const claimed = claimedPorts();
  for (let port = from; port < to; port++) {
    if (claimed.has(port)) continue;
    if (await portIsFree(port)) return port;
  }
  throw new Error(`no free port between ${from} and ${to}`);
}

/** A port the system hands out, free on both loopback addresses. */
export async function ephemeralPort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.on("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    if (await portIsFree(port)) return port;
  }
  throw new Error("could not find a free ephemeral port");
}

function bindable(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

function answers(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/** Reserve before a manifest or renderer is written, under one laptop-wide lock. */
export async function reservePort({ owner, from = 5200, to = 5400 }) {
  if (!owner) throw new Error("A port reservation needs its owning manifest path");
  const record = join(protoHome(), "port-reservations.json");
  return withProcessLock(`${record}.lock`, async () => {
    let reservations = {};
    try { reservations = JSON.parse(readFileSync(record, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [key, reservation] of Object.entries(reservations)) {
      if (existsSync(key)) continue;
      try { process.kill(reservation.pid, 0); }
      catch (error) { if (error.code === "ESRCH") delete reservations[key]; }
    }
    if (reservations[owner]) return reservations[owner].port;
    const claimed = claimedPorts();
    for (const reservation of Object.values(reservations)) claimed.add(reservation.port);
    for (let port = from; port < to; port++) {
      if (!claimed.has(port) && await portIsFree(port)) {
        reservations[owner] = { port, pid: process.pid };
        writeSession(record, reservations);
        return port;
      }
    }
    throw new Error(`No free reserved port between ${from} and ${to}`);
  });
}

export async function releasePort(owner) {
  const record = join(protoHome(), "port-reservations.json");
  return withProcessLock(`${record}.lock`, async () => {
    let reservations;
    try { reservations = JSON.parse(readFileSync(record, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    delete reservations[owner];
    writeSession(record, reservations);
  });
}
