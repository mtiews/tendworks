# The web UI is a same-origin SPA under /ui/, signed in with an API token until OIDC

The web UI (`apps/web`) is a single-page application that the server bundle serves as static files under `/ui/` (`GET /` redirects there), on the same origin as the control plane API, whose paths stay unchanged. It is a client of the public API like `tend`: it uses the client generated from the contract and the transcript streams of ADR 0017, and it has no endpoint of its own. Until identity arrives, the operator signs in by entering an API token: `TEND_API_TOKEN` gives the full UI, `TEND_API_READ_TOKEN` (ADR 0016) a read-only UI without decisions, chat input or cancel. The UI learns which it holds from a new public endpoint, `GET /access` (`{ scope: "read" | "full" }`), which the CLI can show too and which OIDC later answers from the token's claims. The token lives in `sessionStorage`, or in `localStorage` when the operator asks to be remembered on the device; a strict Content Security Policy and sanitized Markdown rendering of agent output (no raw HTML) limit what an injected script could do with it.

## Considered Options

- **Move the API under `/api/`**: frees the root for the UI, but breaks the CLI, scripts and every contract path for a cosmetic gain.
- **Distinguish UI and API by the `Accept` header** on the same paths: fragile with SSE, caches and tools.
- **A separate web container** (e.g. nginx) on its own origin: needs CORS and a second token-handling path, one more service in the laptop profile.
- **A server-side session with a cookie and a login endpoint**: keeps the token out of script reach, but adds a session store and a login endpoint that only the UI uses; OIDC replaces either approach.
- **Let the operator pick read-only at sign-in, or probe a write endpoint for 403**: error-prone or a hack; the scope belongs to the token.

## Consequences

- A script injected into the UI could read the token; sanitizing agent output and the CSP are the guards. Acceptable while the stack is reachable on localhost only; remote access waits for TLS and OIDC.
- The read-only UI is a convenience, not the guard: the API refuses writes with the read token (ADR 0016).
- `/ui/` is reserved on the API's origin; no API path may start with it.
