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
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
