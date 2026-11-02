import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A managed preview is borrowed, never started or stopped by verification.
export async function verifyManagedBuild(folder, address, request = fetch) {
  const url = new URL(address);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.pathname !== "/" || url.search || url.hash)
    throw new Error("Managed preview must be a localhost HTTP origin");
  async function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path, relative + "/");
      else if (entry.isFile()) {
        const response = await request(new URL(relative.split("/").map(encodeURIComponent).join("/"), url), { redirect: "error", signal: AbortSignal.timeout(15000) });
        if (!response.ok || !readFileSync(path).equals(Buffer.from(await response.arrayBuffer())))
          throw new Error(`Managed preview differs from prepared build: ${relative}`);
      } else throw new Error(`Unsupported build entry: ${relative}`);
    }
  }
  await walk(folder);
}
