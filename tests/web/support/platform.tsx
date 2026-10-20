import { createControlPlaneApi, createInMemoryRuns, type ControlPlaneApiOptions } from "@tendworks/control-plane";
import { render } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { App } from "@tendworks/web";

/*
 * The view-test seam (spec #38): the whole web app rendered in jsdom, its `fetch` the real
 * control plane handler over in-memory fakes, in process. The app cannot send what the
 * control plane would not answer, and the tests see only what the operator sees.
 */

// Dummy tokens of the in-process control plane, long enough for its token rules.
export const API_TOKEN = "view-test-api-token"; // betterleaks:allow (dummy token of the view tests)
export const READ_TOKEN = "view-test-read-token"; // betterleaks:allow (dummy token of the view tests)

export type PlatformOptions = Partial<ControlPlaneApiOptions>;

function controlPlane(options: PlatformOptions) {
  return createControlPlaneApi({
    probes: [],
    configuration: { workflowNames: [], workflow: () => undefined, agentProfiles: [], triggerBindings: [], policies: [], pullRequestIntegrations: [] },
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
  return { user, platform, view };
}
