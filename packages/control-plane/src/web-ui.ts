import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

/** Where the built web UI lives (ADR 0018): the entry page `index.html` and Vite's hashed `assets/`. */
export interface WebUiOptions {
  root: string;
}

/** The web UI's path prefix on the API's origin; no API path may start with it (ADR 0018). */
export const WEB_UI_PATH = "/ui/";

/**
 * Scripts, styles and connections from the same origin only, no inline script or style, no
 * framing and no form posting anywhere: an injected script could neither load code nor send
 * the token elsewhere (ADR 0018). Images only from the origin, so rendered agent output
 * cannot leak data through an image URL either.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Sent with every answer under /ui/. */
export const WEB_UI_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Vite names files under assets/ by their content hash, so they never change. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/** The entry page and unhashed files are revalidated on every use, so a new build shows at once. */
const REVALIDATE = "no-cache";

/**
 * Answers a GET or HEAD for `path` under /ui/ from the build in `root`: the file if it exists,
 * the entry page for any other path so the app's client-side routes work as deep links, and
 * `undefined` for a missing asset, so a stale page gets a 404 rather than HTML as a script.
 */
export async function serveWebUi({ root }: WebUiOptions, path: string, method: string): Promise<Response | undefined> {
  const base = resolve(root);
  const relative = path.slice(WEB_UI_PATH.length);
  const file = relative === "" ? undefined : resolve(base, relative);
  // A path that leaves the build (e.g. through an encoded `..`) is answered like an unknown route.
  const inside = file !== undefined && file.startsWith(base + sep);
  if (inside && (await isFile(file))) return answer(file, relative.startsWith("assets/") ? IMMUTABLE : REVALIDATE, method);
  if (relative.startsWith("assets/")) return undefined;
  return answer(resolve(base, "index.html"), REVALIDATE, method);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isFile(),
    () => false,
  );
}

async function answer(file: string, cacheControl: string, method: string): Promise<Response | undefined> {
  const body = await readFile(file).catch(() => undefined);
  if (!body) return undefined;
  const headers = { ...WEB_UI_HEADERS, "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cacheControl };
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}
