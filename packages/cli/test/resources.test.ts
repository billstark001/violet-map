import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resourceCommand } from '../src/commands/resources.js';

test('local prepare saves a complete reviewable manifest without publishing objects or control records', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-cli-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const serverConfig = path.join(root, 'publisher.json');
  await fs.writeFile(
    serverConfig,
    JSON.stringify({
      deployment: { profile: 'public' },
      resources: {
        roles: ['publish'],
        cache: { memoryBytes: 0 },
        delivery: {
          mode: 'public',
          targetMount: { backend: 'auxiliary', prefix: 'public' },
          publicBaseUrl: 'https://resources.example/',
        },
        publication: { storeMount: { backend: 'auxiliary', prefix: 'control' } },
      },
      data: { dir: path.join(root, 'data') },
      worlds: { dir: path.join(root, 'worlds') },
    }),
  );
  const output = path.join(root, 'prepared.json');
  const options = { via: 'local' as const, serverConfig, writersQuiesced: true };
  assert.deepEqual(await resourceCommand('prepare', { ...options, output }), { prepared: output });
  const manifest = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.entries.some((e: { selector: { kind: string } }) => e.selector.kind === 'atlas'));
  assert.deepEqual(await resourceCommand('prepare', options), manifest);
  await assert.rejects(fs.stat(path.join(root, 'data/content/control')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(root, 'data/content/public')), { code: 'ENOENT' });
  const invalid = path.join(root, 'invalid.json');
  await fs.writeFile(invalid, 'null');
  await assert.rejects(
    resourceCommand('publish', { ...options, prepared: invalid, expectedHead: 'none' }),
    /invalid publication document/,
  );
});
