/**
 * What cloudflared is actually doing, read from the run's own tunnel.log
 * (MAA-182). A cloudflared process being alive says nothing: on a network
 * that blocks port 7844 it starts, retries forever and never reaches the
 * edge, so anything that reads "the process is up" as "the address works"
 * sends people to a hostname that answers Cloudflare 530.
 *
 * cloudflared says the truth in three lines of its own log:
 *
 *   INF precheck complete hard_fail=true …      the network cannot carry a tunnel
 *   INF Registered tunnel connection connIndex=2 …   this connection is up
 *   ERR Connection terminated … connIndex=2          and this is it going away
 *
 * so the state is the set of connections registered and not since
 * terminated, reset whenever a new cloudflared process logs "Starting
 * tunnel" into the same appended file.
 *
 * **Do not read hard_fail as the answer, however much it looks like one.**
 * It is the pre-check's verdict, and the pre-check is a separate probe
 * that can pass while the tunnel itself never connects: measured on this
 * laptop on 2026-09-28, with cloudflared's outgoing connections bound to
 * an address it could not route from, every pre-check target reported
 * PASS and hard_fail=false while every single dial to the edge failed.
 * A registered connection is the only thing that means a tunnel exists,
 * so that is what `connected` counts. hard_fail is kept because it is
 * early, arriving about fifteen seconds in against about thirty for a
 * first connection, which is worth skipping a wait for; it is a warning,
 * never a verdict.
 *
 * Reading is incremental: a watch keeps its byte offset and its set, so a
 * heartbeat process pays for the whole log once and then only for what was
 * written since its last beat. A log that shrank was rotated or replaced,
 * and the watch starts over.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** What the tunnel is: still trying, carrying traffic, or unable to exist
 *  on this network. Never a pair of booleans: "up" as "the process runs"
 *  is the bug this replaces. */
export const TUNNEL_CONNECTING = "connecting";
export const TUNNEL_CONNECTED = "connected";
export const TUNNEL_BLOCKED = "blocked";

/** The one sentence a person reads when this network blocks the tunnel.
 *  The kit prints it, the serve and setup skills carry it, and a running
 *  brief gets it through report_progress. Same words everywhere, so the
 *  sentence someone searches for is the sentence they were shown. */
export const TUNNEL_BLOCKED_SENTENCE =
  "This network blocks the connection the tunnel needs (port 7844), so nothing here can go live on it. Publishing still works, and so does everything else this laptop sends to Proto; for a live view use a phone hotspot or another network.";

const STARTING = "Starting tunnel";
const PRECHECK = "precheck complete";
const REGISTERED = "Registered tunnel connection";
const TERMINATED = "Connection terminated";
const UNREGISTERED = "Unregistered tunnel connection";

const connIndexOf = (line) => {
  const found = /connIndex=(\d+)/.exec(line);
  return found ? found[1] : null;
};

/**
 * A watch over one run's tunnel.log. `read()` answers the tunnel's state
 * now, having folded in everything written since the last call.
 *
 * `runDir` is the supervised run directory; the log is the one the
 * supervisor opens for the process named "tunnel".
 */
export function watchTunnel(runDir) {
  const logPath = join(runDir, "tunnel.log");
  const connections = new Set();
  let hardFail = false;
  let offset = 0;
  let carry = "";

  const reset = () => {
    connections.clear();
    hardFail = false;
    carry = "";
  };

  const apply = (line) => {
    if (line.includes(STARTING)) {
      // A fresh cloudflared appending to the same file: everything the
      // last one said is about a process that is gone.
      reset();
      return;
    }
    if (line.includes(PRECHECK)) {
      hardFail = line.includes("hard_fail=true");
      return;
    }
    const connIndex = connIndexOf(line);
    if (connIndex === null) return;
    if (line.includes(REGISTERED)) connections.add(connIndex);
    else if (line.includes(TERMINATED) || line.includes(UNREGISTERED)) connections.delete(connIndex);
  };

  return {
    /** `{ status, connections, hardFail }`: the status is one of the three
     *  constants above, `connections` how many are registered right now,
     *  and `hardFail` whether cloudflared's own pre-check said this network
     *  cannot carry a tunnel. */
    read() {
      let size = 0;
      try {
        size = statSync(logPath).size;
      } catch {
        // No log yet: the supervisor has not started cloudflared, or this
        // run has no tunnel at all. Either way nothing is connected.
        return statusNow();
      }
      if (size < offset) {
        // Rotated or truncated: what we counted is about a file that is gone.
        offset = 0;
        reset();
      }
      if (size > offset) {
        let text = "";
        try {
          // Bytes, not characters: the offset is a file position, and a
          // log line can carry a non-ASCII hostname.
          text = carry + readFileSync(logPath).subarray(offset).toString("utf8");
        } catch {
          return statusNow();
        }
        offset = size;
        const lines = text.split("\n");
        // The last piece may be half a line the writer has not finished.
        carry = lines.pop() ?? "";
        for (const line of lines) apply(line);
      }
      return statusNow();
    },
  };

  function statusNow() {
    let status = TUNNEL_CONNECTING;
    if (connections.size > 0) status = TUNNEL_CONNECTED;
    else if (hardFail) status = TUNNEL_BLOCKED;
    return { status, connections: connections.size, hardFail };
  }
}

/** The state right now, for a caller that asks once (host-library.mjs). */
export function tunnelState(runDir) {
  return watchTunnel(runDir).read();
}
