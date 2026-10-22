import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";


export default defineConfig({
  // Relative asset paths: a published build lives under a path, and
  // relative paths work at any of them.
  base: "./",
  plugins: [vue()],
  server: {
    port: 5173, // keep in sync with public/prototype.json
    strictPort: true,
    cors: true, // the Frame fetches prototype.json cross-origin
  },
});
