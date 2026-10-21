import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('built maintenance runs from a relocated artifact with production dependencies and no TS source/Kit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-db-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(new URL('../dist/', import.meta.url), path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  // Expose only runtime dependencies to the entrypoint. No source tree, tsx or Kit.
  for (const name of ['@electric-sql/pglite', 'drizzle-orm', 'pg', 'yaml']) {
    const target = path.join(root, 'node_modules', name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(
      await fs.realpath(new URL(`../node_modules/${name}`, import.meta.url)),
      target,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }
  const args = [path.join(root, 'dist/src/db/maintenance.js')];
  const options = {
    cwd: root,
    env: { ...process.env, DATABASE_URL: '', DATABASE_DIR: path.join(root, 'data'), VIOLET_MAP_CONFIG: '' },
  };
  const run = async (command) => JSON.parse((await execute(process.execPath, [...args, command], options)).stdout);
  assert.equal((await run('status')).state, 'uninitialized');
  assert.equal((await run('migrate')).state, 'current');
  assert.equal((await run('migrate')).history.length, 1);
  assert.equal((await run('status')).applied[0], '0000_baseline');
  await assert.rejects(run('baseline'), /already has migration history/);
  await assert.rejects(run('invalid'), /Usage:/);
  // The artifact reads its own bundled migration files, irrespective of cwd.
  await fs.appendFile(path.join(root, 'dist/migrations/0000_baseline.sql'), '\n-- changed\n');
  await assert.rejects(run('status'), (error) => {
    assert.equal(error.code, 1);
    const status = JSON.parse(error.stdout);
    assert.equal(status.state, 'invalid');
    assert.match(status.issues[0], /SHA-256 differs/);
    return true;
  });
});
