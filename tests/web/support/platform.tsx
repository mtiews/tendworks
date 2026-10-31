import { createControlPlaneApi, createInMemoryRuns, emptyConfiguration, type ControlPlaneApiOptions } from "@tendworks/control-plane";
import { render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ApiProvider, App, createControlPlaneClient, Router } from "@tendworks/web";
import type { ReactNode } from "react";

/*
 * The view-test seam (spec #38): the whole web app rendered in jsdom, its `fetch` the real
 * control plane handler over in-memory fakes, in process. The app cannot send what the
 * control plane would not answer, and the tests see only what the operator sees. `renderPage`
 * renders a page built from the app's modules on the same control plane.
 */

// Dummy tokens of the in-process control plane, long enough for its token rules.
export const API_TOKEN = "view-test-api-token"; // betterleaks:allow (dummy token of the view tests)
export const READ_TOKEN = "view-test-read-token"; // betterleaks:allow (dummy token of the view tests)

export type PlatformOptions = Partial<ControlPlaneApiOptions>;

/** Makes the window as wide as a phone (or not), as the browser's media query would; delete `window.matchMedia` after the test. */
export function phoneWidth(phone: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: phone && query.includes("max-width: 759"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

/** Starts the next `renderApp` signed in with `token`, as after a sign-in earlier in this tab. */
export function signedIn(token: string = API_TOKEN): void {
  window.sessionStorage.setItem("tendworks.token", token);
}

function controlPlane(options: PlatformOptions) {
  return createControlPlaneApi({
    probes: [],
    configuration: emptyConfiguration(),
    runs: createInMemoryRuns(),
    apiToken: API_TOKEN,
    readToken: READ_TOKEN,
    ...options,
  });
}

/** The running platform behind the app: every request it answered, and a way to restart it with other options. */
export interface Platform {
  requests: Request[];
  /** Replaces the control plane, e.g. with other tokens, as a restart of the server would. */
  restart(options?: PlatformOptions): void;
  /** Makes the platform unreachable (`fetch` fails like a refused connection), or reachable again. */
  unreachable(down: boolean): void;
}

/**
 * Renders the app at `path` (e.g. a deep link) against a fresh control plane. Storage is left
 * as it is, so a second call is the operator opening the app again in the same browser.
 */
export function renderApp({ path = "/ui/", unreachable = false, ...options }: PlatformOptions & { path?: string; unreachable?: boolean } = {}) {
  window.history.replaceState(null, "", path);
  let api = controlPlane(options);
  let down = unreachable;
  const platform: Platform = {
    requests: [],
    restart: (next = {}) => (api = controlPlane(next)),
    unreachable: (value) => (down = value),
  };
  const fetch = async (request: Request): Promise<Response> => {
    platform.requests.push(request.clone());
    if (down) throw new TypeError("fetch failed");
    return api.fetch(request);
  };
  const user = userEvent.setup();
  const view = render(<App fetch={fetch} />);
  /** Opens the app once more at the same address and on the same platform, as a second tab would. */
  const openTab = () => render(<App fetch={fetch} />);
  return { user, platform, view, openTab };
}

/**
 * Renders `page` signed in with `token` against a fresh control plane, inside the app's router
 * and API access but without its shell: a page made of modules the app does not compose that
 * way yet (e.g. a start control that always confirms). It sees only what the operator sees.
 */
export function renderPage(page: ReactNode, { path = "/ui/", token = API_TOKEN, ...options }: PlatformOptions & { path?: string; token?: string } = {}) {
  window.history.replaceState(null, "", path);
  const api = controlPlane(options);
  const client = createControlPlaneClient({ token, fetch: (request) => api.fetch(request) });
  const user = userEvent.setup();
  const view = render(
    <Router>
      <ApiProvider value={{ client, canChange: token !== READ_TOKEN }}>{page}</ApiProvider>
    </Router>,
  );
  return { user, view };
}
