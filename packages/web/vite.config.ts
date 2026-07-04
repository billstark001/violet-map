import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const polyfills = () => nodePolyfills({ globals: { Buffer: true, process: true } });

export default defineConfig({
  plugins: [react(), polyfills()],
  worker: { format: 'es', plugins: () => [polyfills()] },
  optimizeDeps: { exclude: ['@mcr/core'] },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
});