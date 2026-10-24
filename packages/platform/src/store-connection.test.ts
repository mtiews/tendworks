import { describe, expect, it } from "vitest";
import { storeConnectionString } from "./store-connection.js";

describe("the store's connection string", () => {
  it("carries the password percent-encoded, so any generated or chosen password survives the URL", () => {
    const password = "p@ss:w/rd%?#"; // betterleaks:allow test password with every character a URL treats specially

    const url = storeConnectionString({ TEND_DATABASE_URL: "postgres://tend@postgres:5432/tend", TEND_POSTGRES_PASSWORD: password });

    expect(url).toBe("postgres://tend:p%40ss%3Aw%2Frd%25%3F%23@postgres:5432/tend"); // betterleaks:allow the test password above, encoded
    // As the database client reads it back.
    expect(decodeURIComponent(new URL(url).password)).toBe(password);
  });

  it.each([undefined, ""])("is refused without a password (%j), naming the variable to set", (password) => {
    expect(() => storeConnectionString({ TEND_DATABASE_URL: "postgres://tend@postgres:5432/tend", TEND_POSTGRES_PASSWORD: password })).toThrow(
      "TEND_POSTGRES_PASSWORD is not set; scripts/setup-env.sh generates it (docs/operator-guide.md)",
    );
  });

  it("is refused without the store's address", () => {
    expect(() => storeConnectionString({ TEND_POSTGRES_PASSWORD: "secret" })).toThrow("TEND_DATABASE_URL is not set"); // betterleaks:allow dummy password of a refused start
  });
});
