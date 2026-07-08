import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 3310, proxy: { '/api': process.env.API_PROXY ?? 'http://localhost:3300' } },
});
