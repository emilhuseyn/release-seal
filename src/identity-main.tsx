import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./App.css";
import IdentityApp from "./IdentityApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <IdentityApp />
  </StrictMode>,
);
