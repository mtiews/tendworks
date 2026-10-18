import pg from "pg";
import type { HealthProbe } from "../status.js";

/** Checks that the control plane's store accepts connections and queries. */
export function createStoreProbe(connectionString: string): HealthProbe {
  return {
    name: "store",
    async check() {
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1_500 });
      try {
        await client.connect();
        await client.query("SELECT 1");
        return { status: "healthy" };
      } finally {
        await client.end().catch(() => {});
      }
    },
  };
}
