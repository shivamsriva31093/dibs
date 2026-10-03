import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The board is built to board/dist and served by the Worker as static files.
// In development, API and MCP requests go to `wrangler dev`.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/mcp": "http://localhost:8787",
    },
  },
});
