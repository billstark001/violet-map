import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@violet-map/core'] },
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:8787' },
  },
});
