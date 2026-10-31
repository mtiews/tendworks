// The app as a component, for the entry point and the view tests (tests/web).
export { App, type AppProps } from "./app.js";
// The parts a page is built from, for view tests of a module no page uses that way yet.
export { ApiProvider, createControlPlaneClient } from "./api.js";
export { Router } from "./router.js";
export { StartBinding, type StartOptions } from "./start-binding.js";
