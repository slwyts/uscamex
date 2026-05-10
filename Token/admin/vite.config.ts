import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// `base: '/admin/'` so the build is mounted at /admin by the operator.
// `server.proxy` forwards /api during local dev to the operator HTTP server.
export default defineConfig({
  base: "/admin/",
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
