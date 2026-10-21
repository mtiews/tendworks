/** Architecture rules: a domain owns its code; packages only talk through contracts. */
module.exports = {
  forbidden: [
    {
      name: "no-cross-domain-imports",
      comment:
        "A domain package may not import another domain package. Use the published API or events; shared types come from @tendworks/shared, which is generated from contracts/. @tendworks/health and @tendworks/platform are platform libraries, not domains.",
      severity: "error",
      from: { path: "^packages/([^/]+)/", pathNot: "^packages/(health|platform)/" },
      to: { path: "^packages/", pathNot: ["^packages/$1/", "^packages/shared/", "^packages/health/", "^packages/platform/"] },
    },
    {
      name: "platform-libraries-are-leaves",
      comment: "Platform libraries (@tendworks/health, @tendworks/platform) may only use generated types; they must never know a domain or each other.",
      severity: "error",
      from: { path: "^packages/(health|platform)/" },
      to: { path: "^(packages|apps)/", pathNot: ["^packages/$1/", "^packages/shared/"] },
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
      comment:
        "apps/ only bundle packages for operation; nothing may depend on them. The view tests (tests/web) are the one exception: they render the web app against the real control plane in process, which the web app itself may not import.",
      severity: "error",
      from: { path: "^(packages|tests)/" },
      to: { path: "^apps/", pathNot: "^apps/web/" },
    },
    {
      name: "nothing-imports-apps",
      severity: "error",
      from: { path: "^(packages|tests)/", pathNot: "^tests/web/" },
      to: { path: "^apps/web/" },
    },
    {
      name: "web-app-is-a-client",
      comment:
        "The web UI is a client of the public API like tend (ADR 0018): it may import only the generated types and the browser-safe platform library (packages/platform, not packages/health), and no Node.js module, since it runs in the browser.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^(packages|apps)/", pathNot: ["^apps/web/", "^packages/shared/", "^packages/platform/"] },
    },
    {
      name: "web-app-is-a-client",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { dependencyTypes: ["core"] },
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
      extensions: [".ts", ".tsx", ".js"],
    },
  },
};
