import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript sources under the "source"
// condition, so unit tests run without a prior build.
const conditions = ["source", ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "tests/architecture/**/*.test.ts", "tests/contract/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
        },
      },
      {
        // Adapters against their real products (e.g. Docker); needs a Docker host.
        extends: true,
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.integration.test.ts"],
          maxConcurrency: 16,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          testTimeout: 30_000,
          // One stack for all files; the restart test must not pull it away from the others.
          fileParallelism: false,
        },
      },
    ],
  },
});
