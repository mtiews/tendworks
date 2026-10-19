// Code quality rules on top of the type checker and the architecture rules (dependency-cruiser).
// Type-aware rules catch async mistakes (floating or misused promises) that tests easily miss.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "packages/shared/src/generated/**",
      "tests/architecture/fixtures/**",
      "images/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./packages/*/tsconfig.json", "./apps/*/tsconfig.json", "./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-console": ["error", { allow: ["warn", "error", "info"] }],
      // Port implementations and fakes are async to satisfy the port's Promise signature
      // even when they await nothing.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Tests read untyped JSON from APIs on purpose and assert its shape.
    files: ["**/*.test.ts", "**/*.suite.ts", "**/*.stub.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // Entry points log their startup to stdout.
    files: ["apps/*/src/main.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: "readonly", console: "readonly", module: "writable", require: "readonly" } },
  },
);
