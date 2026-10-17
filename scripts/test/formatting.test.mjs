import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const project = fileURLToPath(new URL('../../', import.meta.url));

test('Oxlint enforces top-level section padding while preserving import and variable groups', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-padding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.ts');
  const source =
    [
      "import { basename } from 'node:path';",
      "import { tmpdir } from 'node:os';",
      'export const first = basename(tmpdir());',
      'export const second = first.length;',
      'export function one() { const value = 1; return value; }',
      'export function two() { return second; }',
      'export class Thing {}',
      'export const arrowOne = () => first;',
      'export const arrowTwo = () => second;',
      "export { readFile } from 'node:fs';",
      "export { stat } from 'node:fs';",
    ].join('\n') + '\n';
  await fs.writeFile(file, source);
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [path.join(project, 'node_modules/oxlint/bin/oxlint'), '-c', path.join(project, '.oxlintrc.json'), ...args, file],
      { cwd: project, encoding: 'utf8' },
    );
  assert.equal(run().status, 1);
  const fixed = run('--fix');
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  const result = await fs.readFile(file, 'utf8');
  assert.ok(result.includes("from 'node:path';\nimport"), 'imports remain grouped');
  assert.ok(result.includes('tmpdir());\nexport const second'), 'ordinary variables remain grouped');
  assert.ok(result.includes('first.length;\n\nexport function one'));
  assert.ok(result.includes('return value; }\n\nexport function two'));
  assert.ok(result.includes('return second; }\n\nexport class'));
  assert.ok(result.includes('() => first;\n\nexport const arrowTwo'));
  assert.ok(result.includes("from 'node:fs';\nexport { stat }"), 'reexports remain grouped');
  assert.equal(run().status, 0);
});
