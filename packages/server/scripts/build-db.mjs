import { cp, rm } from 'node:fs/promises';

const output = new URL('../dist/migrations/', import.meta.url);
await rm(output, { recursive: true, force: true });
await cp(new URL('../migrations/', import.meta.url), output, { recursive: true });
