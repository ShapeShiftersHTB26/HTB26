import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import accessGate from "./access-gate";

export default defineConfig({
  plugins: [
    accessGate(process.env.ACCESS_CODE), // ACCESS_CODE set = the whole site asks for it first
    react(),
    // The Predictions tab's Solana libraries (web3.js, anchor) expect Node globals in the browser.
    nodePolyfills({ include: ["buffer", "process", "crypto", "stream", "util"], globals: { Buffer: true, process: true } }),
  ],
  server: {
    port: 5173,
    watch: { usePolling: true }, // bind mounts on Windows don't emit fs events
    proxy: {
      "/api": process.env.API_URL || "http://localhost:8000",
      // Predictions tab → prediction-market backend
      "/pm-api": {
        target: process.env.PM_API_URL || "http://localhost:8080",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pm-api/, ""),
      },
    },
  },
});
