import { artifactRef, sha256 } from '@violet-map/storage';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { MemoryActionIndex } from '../src/index.js';

const ref = artifactRef(new Uint8Array([1, 2, 3]), 'image/png', 'png');
const key = sha256('input');

test('memory index has a separate byte ceiling and protects stored references from caller mutation', async () => {
  const disabled = new MemoryActionIndex(0);
  await disabled.set(key, ref);
  assert.equal(await disabled.get(key), undefined);
  const index = new MemoryActionIndex(512);
  const input = { ...ref };
  await index.set(key, input);
  input.digest = sha256('changed');
  assert.deepEqual(await index.get(key), ref);
  const returned = (await index.get(key))!;
  returned.bytes = 500;
  assert.deepEqual(await index.get(key), ref);
  for (let i = 0; i < 50; i++) await index.set(sha256(String(i)), ref);
  assert.ok(index.bytes <= 512);
  index.close();
  assert.equal(index.bytes, 0);
});

test('SQLite is selected explicitly, survives restart, bounds records, and rejects unknown schemas', async (t) => {
  const { SqliteActionIndex } = await import('../src/catalog/sqlite.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-resource-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'index.sqlite');
  const first = new SqliteActionIndex(file, 1024);
  await first.set(key, ref);
  first.close();
  const second = new SqliteActionIndex(file, 1024);
  assert.deepEqual(await second.get(key), ref);
  for (let i = 0; i < 100; i++) await second.set(sha256(String(i)), ref);
  second.close();
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(file);
  assert.ok(Number(database.prepare('SELECT SUM(bytes) AS bytes FROM actions').get()!.bytes) <= 1024);
  database.exec('PRAGMA user_version=99');
  database.close();
  assert.throws(() => new SqliteActionIndex(file, 1024), /unsupported.*reindex/);
  await fs.writeFile(path.join(root, 'corrupt.sqlite'), 'broken');
  assert.throws(() => new SqliteActionIndex(path.join(root, 'corrupt.sqlite'), 1024));
});

test('memory entry imports and runs without loading any filesystem or SQLite driver', async () => {
  const run = promisify(execFile);
  const program = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (['node:sqlite', 'sqlite', 'node:fs', 'fs', 'node:fs/promises', 'fs/promises'].includes(specifier)) throw new Error('unexpected persistence module: ' + specifier);
      return next(specifier, context);
    }});
    const { BlobRepository, createActionIndex, InvalidationCoordinator } = await import('@violet-map/resources');
    const repository = new BlobRepository({ memoryBytes: 0, workBytes: 64, handoffBytes: 64, handoffMs: 100, maxTasks: 1, index: await createActionIndex({ driver: 'memory' }, 1024), source: new InvalidationCoordinator() });
    const result = await repository.ensure({actionKey: 'a'.repeat(64), generation: 0, mediaType: 'image/png', format: 'png', maxBytes: 8, workBytes: 8, generate: async () => new Uint8Array([1])});
    repository.open(result.artifact); await repository.close();
  `;
  await run(process.execPath, ['--import', 'tsx', '--conditions=development', '--input-type=module', '-e', program], {
    cwd: new URL('../', import.meta.url),
  });
});
