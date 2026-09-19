#!/usr/bin/env node
/** Static server for laptop-served Proto surfaces (library viewer, static
 *  prototypes). CORS on (the Proto app probes manifests cross-origin) and
 *  no-store (live population must never fight a cache). */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const [dirArg, portArg] = process.argv.slice(2);
if (!dirArg) {
  console.error("usage: node serve.mjs <dir> [port]");
  process.exit(1);
}
const root = resolve(dirArg);
const port = Number(portArg ?? 5210);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname));
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? join(file, "index.html") : file;
    const body = await readFile(target);
    res.writeHead(200, {
      ...headers,
      "Content-Type": TYPES[extname(target)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404, headers);
    res.end("not found");
  }
}).listen(port, () => {
  console.log(`serving ${root} on http://localhost:${port}`);
});
