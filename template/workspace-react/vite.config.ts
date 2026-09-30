import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const tunnel = process.env.PROTO_TUNNEL === "1";

export default defineConfig({
  // Relative asset paths: a published build lives under a path, and
  // relative paths work at any of them.
  base: "./",
  plugins: [react()],
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
      hmr: { protocol: "wss", clientPort: 443 },
    }),
  },
});
