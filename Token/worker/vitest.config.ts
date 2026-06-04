import { defineConfig } from "vitest/config";

// Pure-logic tests (engine/config/indexer/journal) run in plain Node.
// They cover the high-risk ported accounting and decoding. DO/Worker integration
// tests would require @cloudflare/vitest-pool-workers; not needed for these units.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
