import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Each test starts in a fresh browser: nothing rendered, nothing stored.
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
