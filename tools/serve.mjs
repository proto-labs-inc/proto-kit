#!/usr/bin/env node
/** Static server for laptop-served static folders (an import's unit
 *  folder, static prototypes). CORS on and no-store (files rewritten
 *  mid-run must never fight a cache). Port 0 picks a free one, so
 *  parallel units never collide; the port is printed either way.
 *  Usage: node serve.mjs <dir> [port] */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const [dirArg, portArg] = process.argv.slice(2);
if (!dirArg) {
  console.error("usage: node serve.mjs <dir> [port]   (port 0 picks a free one)");
  process.exit(1);
}
const root = resolve(dirArg);
const port = Number(portArg ?? 0);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mjs": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  let path = normalize(decodeURIComponent(url.pathname));
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  if (path.endsWith("/")) path += "index.html";
  const file = join(root, path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
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
}

const server = createServer(handle).listen(port, () => {
  console.log(`serving ${root} on http://localhost:${server.address().port}`);
});
