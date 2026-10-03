import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === "development" ? "/" : "/lag_app/",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
  },
}));
