// A kernel-owned localhost listener is a cross-process mutex. The OS releases
// it on crash/exit, so no process can accidentally delete a successor's lock.
// Hash collisions only serialize unrelated resources; they never share ownership.
import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

const listeners = new Map();

export async function acquireProcessLock(path, { timeoutMs = 120_000 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const identity = join(await realpath(dirname(path)), basename(path));
  // Outside prototype, debug, renderer, e2e, and OS ephemeral port ranges.
  const port = 12000 + createHash("sha256").update(identity).digest().readUInt32BE(0) % 6000;
  const deadline = Date.now() + timeoutMs;
  const releaseIdentity = entry => {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      entry.identities.delete(identity);
      if (entry.identities.size === 0) {
        listeners.delete(port);
        await new Promise(resolve => entry.server.close(resolve));
      }
    };
  };
  for (;;) {
    const local = listeners.get(port);
    if (local && !local.identities.has(identity)) {
      local.identities.add(identity);
      return releaseIdentity(local);
    }
    const server = createServer(socket => socket.destroy());
    const result = await new Promise(resolve => {
      server.once("error", resolve);
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () => resolve(null));
    });
    if (!result) {
      const entry = { server, identities: new Set([identity]) };
      listeners.set(port, entry);
      return releaseIdentity(entry);
    }
    if (result.code !== "EADDRINUSE") throw result;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for resource lock ${path} (localhost:${port})`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

export async function withProcessLock(path, work, options) {
  const release = await acquireProcessLock(path, options);
  try { return await work(); } finally { await release(); }
}
