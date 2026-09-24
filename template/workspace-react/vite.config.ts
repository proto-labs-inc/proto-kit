import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pre-npm: the rig ships as source. PROTO_PACKAGES points at a proto
// checkout's packages/ dir (the scaffolder writes it into .env or the dev
// script from ~/.proto/config.json). Once @proto/rig publishes to npm it
// becomes a plain dependency and this whole block goes away.
const packages = process.env.PROTO_PACKAGES;
const tunnel = process.env.PROTO_TUNNEL === "1";

export default defineConfig({
  // Relative asset paths: a published build lives under a path, and
  // relative paths work at any of them.
  base: "./",
  plugins: [react()],
  resolve: {
    // The source-aliased rig resolves from outside this standalone
    // workspace. Keep its hooks on the prototype's React runtime in both
    // dev and production builds.
    dedupe: ["react", "react-dom"],
    ...(packages && {
      alias: {
        "@proto/rig": `${packages}/rig/src/index.tsx`,
        "@proto/rig-core": `${packages}/rig-core/src/index.ts`,
        "@proto/wire": `${packages}/wire/src/index.ts`,
        // The rig lazy-imports this from the prototype's own deps; with the
        // rig aliased from outside the root, vite needs the resolution pinned.
        "modern-screenshot": fileURLToPath(
          new URL("./node_modules/modern-screenshot/dist/index.mjs", import.meta.url),
        ),
      },
    }),
  },
  server: {
    port: 5173, // keep in sync with public/prototype.json
    strictPort: true,
    cors: true, // the Frame fetches prototype.json cross-origin
    // Tunnel gotchas: accept the public hostname + wss HMR when served
    // through the gateway. Off by default so local dev stays untouched.
    ...(tunnel && {
      allowedHosts: true,
      hmr: { protocol: "wss", clientPort: 443 },
    }),
  },
});
