import { readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const tunnel = process.env.PROTO_TUNNEL === "1";
const publicDir = fileURLToPath(new URL("./public", import.meta.url));

// Variant previews land in public/previews while this server is already
// running. Vite only serves a public file it saw at startup or through
// its watcher, and the watcher ignores pictures so a capture does not
// reload every open page. Read previews/ and wireframes/ from disk
// instead. A file that is not there yet is a 404, never the app page:
// the browser would cache that page under the image URL.
const PUBLISHED = /^\/(?:previews|wireframes)\//;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

function publicAssets(): Plugin {
  return {
    name: "proto-public-assets",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
        if (!PUBLISHED.test(pathname)) {
          next();
          return;
        }
        const file = join(publicDir, pathname);
        if (relative(publicDir, file).startsWith("..")) {
          next();
          return;
        }
        try {
          const body = await readFile(file);
          const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
          res.setHeader("Content-Type", type);
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  // Relative asset paths: a published build lives under a path, and
  // relative paths work at any of them.
  base: "./",
  plugins: [react(), publicAssets()],
  server: {
    port: 5173, // keep in sync with public/prototype.json
    strictPort: true,
    cors: true, // the Frame fetches prototype.json cross-origin
    // A build's lanes add parts while its checks run in other pages; a
    // new file that is not a module (a part's notes, its fonts and
    // pictures) would otherwise reload every open page mid-capture.
    watch: { ignored: ["**/notes.md", "**/*.woff2", "**/*.woff", "**/*.ttf", "**/*.otf", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.avif", "**/*.svg"] },
    // Tunnel gotchas: accept the public hostname + wss HMR when served
    // through the gateway. Off by default so local dev stays untouched.
    ...(tunnel && {
      allowedHosts: true,
    }),
  },
});
