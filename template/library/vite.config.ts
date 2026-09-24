import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const tunnel = process.env.PROTO_TUNNEL === "1";
const publicDir = fileURLToPath(new URL("./public", import.meta.url));

// The import writes the contract files into public/ while this server
// runs (docs/library-contract.md). Vite only serves public files it saw
// at start-up or through its watcher, and the watcher reloads the page
// for every new state .html, so the data is served here instead, with
// no-store, and the watcher leaves public/ alone. The same middleware
// takes the app's "Queue it": a POST of { slug } appends a request to
// public/queue.json, where the import polls for it. A published build
// has no server behind it, so there the POST fails and the app says so.
const DATA = /^\/(manifest\.json|events\.jsonl|queue\.json|components\/)/;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function libraryData(): Plugin {
  return {
    name: "library-data",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname));
        if (!DATA.test(path)) {
          next();
          return;
        }
        if (req.method === "POST" && path === "/queue.json") {
          let body = "";
          for await (const chunk of req) body += chunk;
          const { slug } = JSON.parse(body) as { slug: string };
          const file = join(publicDir, "queue.json");
          const queue = JSON.parse(await readFile(file, "utf8")) as { requests: { slug: string; at: string }[] };
          if (!queue.requests.some((r) => r.slug === slug)) {
            queue.requests.push({ slug, at: new Date().toISOString() });
          }
          await writeFile(file, JSON.stringify(queue, null, 2) + "\n");
          res.setHeader("Content-Type", TYPES[".json"]);
          res.end(JSON.stringify(queue));
          return;
        }
        const file = join(publicDir, path);
        if (!file.startsWith(publicDir)) {
          next();
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        try {
          const body = await readFile(file);
          res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(body);
        } catch {
          // A state file that is not there yet is a 404, never the SPA
          // fallback: the browser would cache the app's own page under
          // the state's URL and keep showing it inside the frame.
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths: the published build lives under the codebase's
  // library path, and relative paths work at any of them.
  base: "./",
  plugins: [react(), tailwindcss(), libraryData()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5210,
    strictPort: true,
    cors: true, // the app's Design system page probes manifest.json cross-origin
    watch: { ignored: [`${publicDir}/**`] },
    // Through the library tunnel: accept the public hostname and use wss HMR.
    ...(tunnel && {
      allowedHosts: true,
      hmr: { protocol: "wss", clientPort: 443 },
    }),
  },
});
