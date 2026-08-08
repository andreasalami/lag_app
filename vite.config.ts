import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === "development" ? "/" : "/lag_app/",
  plugins: [react()],
  server: {
    port: 5173,
  },
}));
