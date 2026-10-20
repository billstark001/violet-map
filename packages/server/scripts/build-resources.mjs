import { cp } from 'node:fs/promises';

for (const name of ['migrations'])
  await cp(new URL(`../${name}/`, import.meta.url), new URL(`../dist/${name}/`, import.meta.url), { recursive: true });
