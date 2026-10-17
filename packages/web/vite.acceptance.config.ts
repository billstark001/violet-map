import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import base from './vite.config';

// A separate production build exercises the viewer's real chunk splitting without shipping fixtures.
export default defineConfig({
  ...base,
  base: '/',
  build: {
    ...base.build,
    rolldownOptions: {
      ...base.build?.rolldownOptions,
      input: {
        viewer: fileURLToPath(new URL('./index.html', import.meta.url)),
        harness: fileURLToPath(new URL('./test/overlay-browser.html', import.meta.url)),
        transparency: fileURLToPath(new URL('./test/transparency-browser.html', import.meta.url)),
      },
    },
  },
});
