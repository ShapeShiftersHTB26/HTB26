import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    watch: { usePolling: true }, // bind mounts on Windows don't emit fs events
    proxy: { "/api": process.env.API_URL || "http://localhost:8000" },
  },
});
