import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";
import "./shell.css";
import "./runs.css";
import "./approvals.css";
import "./transcript.css";
import "./chats.css";

const root = document.getElementById("root");
if (!root) throw new Error("the entry page has no #root");

createRoot(root).render(
  <StrictMode>
    <App fetch={(request) => window.fetch(request)} />
  </StrictMode>,
);
