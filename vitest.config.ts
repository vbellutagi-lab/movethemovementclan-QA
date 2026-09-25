import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./src/support/global-setup.ts"],
    // This suite drives a real, shared, external instance (not an isolated test DB per file) —
    // every file books/cancels/grants against the SAME seeded client and org. Running files in
    // parallel causes them to race for the same bookable sessions and credit balance, so we
    // deliberately serialize: one file at a time, in file-declaration order within a directory.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ["default"],
  },
});
