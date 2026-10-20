import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execute, project, cleanEnv } from '../../../scripts/acceptance/helpers/artifacts.mjs';

test('production resource library is self-contained; memory needs no persistence driver and storage has no generator dependencies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-resource-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifact = path.join(root, 'resources');
  await execute('pnpm', ['--filter', '@violet-map/resources', 'deploy', '--legacy', '--prod', artifact], {
    cwd: project,
    timeout: 120_000,
  });
  for (const [name, location] of [
    ['resources', artifact],
    ['core', path.join(artifact, 'node_modules/@violet-map/core')],
    ['storage', path.join(artifact, 'node_modules/@violet-map/storage')],
  ]) {
    await assert.rejects(fs.stat(path.join(location, 'src')), { code: 'ENOENT' });
    const manifest = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
    for (const entry of Object.values(manifest.exports))
      for (const condition of ['default', 'types'])
        assert.ok((await fs.stat(path.join(location, entry[condition]))).isFile());
    if (name === 'storage')
      for (const dependency of ['@violet-map/resources', 'pngjs', '@msgpack/msgpack'])
        assert.equal(Object.hasOwn(manifest.dependencies, dependency), false);
  }
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({resolve(specifier, context, next) {
      if (['node:sqlite','node:fs','node:fs/promises','fs','fs/promises'].includes(specifier)) throw new Error('unselected driver ' + specifier);
      return next(specifier, context);
    }});
    const { BlobRepository, createActionIndex, InvalidationCoordinator } = await import('./dist/index.js');
    const repository = new BlobRepository({memoryBytes: 0, workBytes: 128, handoffBytes: 128, handoffMs: 1000, maxTasks: 1, index: await createActionIndex({driver: 'memory'}, 4096), source: new InvalidationCoordinator()});
    const lease = await repository.ensure({actionKey: 'a'.repeat(64), generation: 0, mediaType: 'image/png', format: 'png', maxBytes: 32, workBytes: 32, generate: async () => new Uint8Array([1,2,3])});
    assert.deepEqual(repository.open(lease.artifact), new Uint8Array([1,2,3]));
    assert.equal(repository.cache.bytes,0); await repository.close();
  `,
    ],
    { cwd: artifact, env: cleanEnv },
  );
});
