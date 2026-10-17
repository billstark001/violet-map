import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadServerConfig } from '../src/configuration.js';
import { createServices } from '../src/services.js';
import { createApp } from '../src/app.js';

test('invalid and oversized biome edits preserve the last usable definitions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-biomes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'sync',
      STATIC_TOKEN_ROLE: 'admin',
      STATIC_API_TOKEN: 'test',
      DATA_WRITES_ENABLED: 'true',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      UPLOAD_BYTES: '512',
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  const app = createApp(config, services);
  const headers = { authorization: 'Bearer test', 'content-type': 'application/json' };
  const valid = {
    default: { temperature: 0.8, downfall: 0.4, effects: { sky_color: 1, fog_color: 2, water_color: 3 } },
  };
  assert.equal(
    (await app.request('/api/data/biomes', { method: 'PUT', headers, body: JSON.stringify(valid) })).status,
    200,
  );
  for (const body of ['null', '[]', '{"bad":{}}', '{', ' '.repeat(513)]) {
    const response = await app.request('/api/data/biomes', { method: 'PUT', headers, body });
    assert.equal(response.status, body.length > 512 ? 413 : 400);
    assert.deepEqual(await services.gameData.readBiomes(), valid);
  }
});
