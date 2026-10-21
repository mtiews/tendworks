import type { ControlPlane } from "@tendworks/shared";
import createClient, { type Client } from "openapi-fetch";
import { createContext, useContext, type ReactNode } from "react";

/** How the app reaches the platform: the browser's fetch, or the control plane in process in the view tests. */
export type Fetch = (request: Request) => Promise<Response>;

/** The client generated from the control plane contract (ADR 0018), as `tend` uses it. */
export type ControlPlaneClient = Client<ControlPlane.paths>;

export type Scope = ControlPlane.components["schemas"]["Access"]["scope"];

/**
 * A client for `token`, on the app's own origin. Any 401 calls `unauthorized`, so a token
 * that stops being accepted sends the operator back to sign-in from wherever the app is.
 */
export function createControlPlaneClient({ token, fetch, unauthorized }: { token: string; fetch: Fetch; unauthorized?: () => void }): ControlPlaneClient {
  const client = createClient<ControlPlane.paths>({ baseUrl: window.location.origin, headers: { authorization: `Bearer ${token}` }, fetch });
  if (unauthorized) {
    client.use({
      onResponse({ response }) {
        if (response.status === 401) unauthorized();
      },
    });
  }
  return client;
}

/** What `token` may do, `refused` when the platform does not accept it, `unreachable` when there is no answer. */
export async function checkAccess(token: string, fetch: Fetch): Promise<Scope | "refused" | "unreachable"> {
  try {
    const { data, response } = await createControlPlaneClient({ token, fetch }).GET("/access");
    if (data) return data.scope;
    return response.status === 401 ? "refused" : "unreachable";
  } catch {
    return "unreachable";
  }
}

interface Api {
  client: ControlPlaneClient;
  /**
   * Whether the token may change state (access scope `full`). Without it (the read-only
   * token) the UI only shows; it offers no action the API would refuse (ADR 0016, ADR 0018).
   */
  canChange: boolean;
}

const ApiContext = createContext<Api | undefined>(undefined);

export function ApiProvider({ value, children }: { value: Api; children: ReactNode }) {
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

/** The signed-in client and its access; views read the platform through it. */
export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi needs a signed-in <ApiProvider>");
  return api;
}
