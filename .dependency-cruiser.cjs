/** Architecture rules: a domain owns its code; packages only talk through contracts. */
module.exports = {
  forbidden: [
    {
      name: "no-cross-domain-imports",
      comment:
        "A domain package may not import another domain package. Use the published API or events; shared types come from @tendworks/shared, which is generated from contracts/. @tendworks/health is a platform library, not a domain.",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: { path: "^packages/", pathNot: ["^packages/$1/", "^packages/shared/", "^packages/health/"] },
    },
    {
      name: "health-is-a-leaf-library",
      comment: "@tendworks/health may only use generated types; it must never know a domain.",
      severity: "error",
      from: { path: "^packages/health/" },
      to: { path: "^(packages|apps)/", pathNot: ["^packages/health/", "^packages/shared/"] },
    },
    {
      name: "shared-is-generated-types-only",
      comment: "@tendworks/shared contains only types generated from contracts/ and depends on nothing.",
      severity: "error",
      from: { path: "^packages/shared/" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/shared/" },
    },
    {
      name: "nothing-imports-apps",
      comment: "apps/ only bundle packages for operation; nothing may depend on them.",
      severity: "error",
      from: { path: "^(packages|tests)/" },
      to: { path: "^apps/" },
    },
    {
      name: "no-unresolvable-imports",
      comment: "Every import must resolve, so an undeclared workspace dependency cannot slip past the rules above.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "apps-do-not-import-each-other",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: ["(^|/)(dist|node_modules)/", "^tests/architecture/fixtures/"] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.test.json" },
    enhancedResolveOptions: {
      conditionNames: ["source", "import", "types", "default"],
      exportsFields: ["exports"],
      extensions: [".ts", ".js"],
    },
  },
};
