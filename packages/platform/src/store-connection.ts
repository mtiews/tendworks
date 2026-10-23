/**
 * The connection string of the platform's store, as the bundles build it from their
 * environment: `TEND_DATABASE_URL` without a password, and `TEND_POSTGRES_PASSWORD`, which
 * has no default (`scripts/setup-env.sh` generates it). Never log the result.
 *
 * Imported as `@tendworks/platform/store-connection`, outside the browser-safe entry point.
 */
export function storeConnectionString(environment: Record<string, string | undefined>): string {
  const address = environment.TEND_DATABASE_URL;
  if (!address) throw new Error("TEND_DATABASE_URL is not set");
  const password = environment.TEND_POSTGRES_PASSWORD;
  if (!password) throw new Error("TEND_POSTGRES_PASSWORD is not set; scripts/setup-env.sh generates it (docs/operator-guide.md)");
  const url = new URL(address);
  // Percent-encoded as a whole: the URL setter leaves characters such as "%" and "?" as they are.
  url.password = encodeURIComponent(password);
  return url.toString();
}
