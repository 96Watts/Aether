import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { EulaGate } from "./EulaGate";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <EulaGate>
      <App />
    </EulaGate>
  </React.StrictMode>,
);