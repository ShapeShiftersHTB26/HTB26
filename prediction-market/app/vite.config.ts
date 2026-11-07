import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// web3.js / anchor 0.29 expect Buffer, process, etc. in the browser.
export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer', 'process', 'crypto', 'stream', 'util'], globals: { Buffer: true, process: true } })],
  server: { port: 5173 },
});
