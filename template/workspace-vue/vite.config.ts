import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const tunnel = process.env.PROTO_TUNNEL === "1";

export default defineConfig({
  // Relative asset paths: a published build lives under a path, and
  // relative paths work at any of them.
  base: "./",
  plugins: [vue()],
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
