import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// `base: '/'` so the SPA is served from the Worker root (Workers Static Assets).
// `server.proxy` forwards /api during local dev to the operator HTTP server.
export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5179,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
