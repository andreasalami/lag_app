import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import "./preview.css";
import { SecurityPreview } from "./SecurityPreview";
import { PreparationPreview } from "./PreparationPreview";
import { OrderExperiencePreview } from "./OrderExperiencePreview";

// Separate development entry point: no Supabase client, auth session or remote
// mutation is loaded by this preview. Vite's normal build uses index.html only.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{new URLSearchParams(location.search).get("vista") === "preparazione" ? <PreparationPreview/> : new URLSearchParams(location.search).get("vista") === "salvataggio" ? <SecurityPreview/> : <OrderExperiencePreview />}</React.StrictMode>,
);
