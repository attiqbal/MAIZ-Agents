import { defineConfig } from "vitest/config";

// Stress scenarios: slower, print real numbers to test/stress/out/report.json. Run with `npm run stress`.
export default defineConfig({
  test: {
    include: ["test/stress/**/*.stress.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
