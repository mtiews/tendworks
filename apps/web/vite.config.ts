import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// The running stack the dev server proxies the API to (`pnpm e2e` or `docker compose up` leave it on :8080).
const target = process.env.TEND_URL ?? "http://localhost:8080";

export default defineConfig({
  // The server serves the build under /ui/ (ADR 0018).
  base: "/ui/",
  plugins: [react()],
  // Workspace packages (the platform libraries) resolve to their TypeScript sources.
  resolve: { conditions: ["source", ...defaultClientConditions] },
  build: {
    // The polyfill would be an inline script, which the Content Security Policy forbids.
    modulePreload: { polyfill: false },
    // Small assets stay files: a data: URL would need a looser policy.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Everything outside /ui/ is the API (including `/` and its redirect); SSE streams pass through.
    proxy: { "^/(?!ui(/|$))": { target, changeOrigin: true } },
  },
});
