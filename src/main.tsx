import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerServiceWorker } from "./lib/pushNotifications";

if ("serviceWorker" in navigator) {
  void registerServiceWorker().catch(() => {
    // Il sito continua a funzionare anche se il browser non abilita Web Push.
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
