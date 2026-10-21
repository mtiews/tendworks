import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no layout and does not implement scrolling: it is a no-op here, and tests that
// look at scrolling give the page a layout of their own.
window.scrollTo = () => undefined;

// Each test starts in a fresh browser: nothing rendered, nothing stored.
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});
