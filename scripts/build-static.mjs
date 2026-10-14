import { copyFile } from 'node:fs/promises';
await copyFile(
  new URL('./serve-static.mjs', import.meta.url),
  new URL(`../packages/${process.argv[2]}/dist/serve.mjs`, import.meta.url),
);
