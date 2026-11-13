# Website

The project website at [tendworks.dev](https://tendworks.dev): a single landing page, built as a static site with [Astro](https://astro.build) and published by Cloudflare Pages. It is not part of the platform: no platform package imports it, and `pnpm check` does not lint it.

## Content and assets

- Text follows the repository README. When the README's pitch changes, update `src/pages/index.astro` with it.
- Logo, mark and the "How it works" diagram are imported from `docs/brand/` and `docs/diagrams/`, never copied.
- `public/` holds files that need a fixed URL: `favicon.svg` (a copy of `docs/brand/favicon.svg`), and PNGs rendered from `docs/brand/`: `social-1200x630.png` (Open Graph image, from `social-1200x630.svg`) and `apple-touch-icon.png` (180 px, from `app-icon-maskable.svg`). Render them again when the brand changes.
- `public/_headers` sets the response headers on Cloudflare Pages: a content security policy that allows only the site's own origin, and long caching for the hashed build output under `/_astro/`.
- Headings use Nunito, the wordmark's typeface, served from the site itself (`@fontsource-variable/nunito`); the site loads nothing from other origins.

## Commands

From the repository root:

| Command | Does |
| --- | --- |
| `pnpm --filter @tendworks/site dev` | dev server at `http://localhost:4321/` |
| `pnpm --filter @tendworks/site build` | static build into `site/dist/` |
| `pnpm --filter @tendworks/site preview` | serves `site/dist/` |

## Publishing on Cloudflare Pages

Cloudflare builds the site from GitHub: every push to `main` publishes it, every pull request gets a preview URL. One-time setup in the Cloudflare dashboard:

1. **Workers & Pages → Create → Pages → Connect to Git**, choose `mtiews/tendworks`.
2. Build settings:
   - Production branch: `main`
   - Framework preset: none
   - Build command: `pnpm --filter @tendworks/site build`
   - Build output directory: `site/dist`
   - Root directory: empty (the repository root, so pnpm finds the workspace and its lockfile)
   - Environment variable: `NODE_VERSION` = `24`
3. After the first build: **Custom domains → Set up a custom domain**, `tendworks.dev`. The zone is on Cloudflare, so the DNS record and the certificate are created automatically. Add `www.tendworks.dev` the same way, and a redirect rule `www.tendworks.dev/*` → `https://tendworks.dev/${1}` (301).
4. **Settings → Builds → Build watch paths**: include `site/*`, `docs/brand/*`, `docs/diagrams/*`, `pnpm-lock.yaml`, so commits that do not touch the site do not rebuild it.
