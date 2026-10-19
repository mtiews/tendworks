import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Workspace packages export their TypeScript sources under the "source"
// condition, so unit tests run without a prior build.
const conditions = ["source", ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    // Measured over unit + integration tests together (`pnpm coverage`), because adapters are
    // only exercised against their real products. Thresholds sit just below the measured
    // baseline (2026-10-19: lines 94.7 %, statements 91.7 %, functions 90.2 %, branches 81.1 %)
    // so coverage cannot silently drop; raise them when coverage improves, never lower them
    // without a reason in the pull request.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/*.suite.ts",
        "**/*.stub.ts",
        "packages/shared/**", // generated types only
        "apps/*/src/main.ts", // wiring, covered by the end-to-end tests
      ],
      reporter: ["text-summary", "html", "json-summary"],
      thresholds: {
        lines: 92,
        statements: 90,
        functions: 88,
        branches: 79,
        // Every domain package must stay well covered on its own, not only on average.
        "packages/*/src/**": { lines: 88, branches: 72 },
        "apps/cli/src/**": { lines: 88, branches: 72 },
      },
    },
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
