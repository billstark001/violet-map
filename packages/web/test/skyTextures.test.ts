import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { loadSkyTextures } from '../src/runtime/skyTextures.js';
import { resourceDownloader } from '../src/resources/download.js';

test('sky admission retries the selected image, uses alternate layouts only for explicit absence and never fabricates an image', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const ids: string[] = [];
  let busy = true;
  let mode: 'present' | 'absent' | 'invalid' = 'present';
  const previousImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  t.after(() => {
    if (previousImage) Object.defineProperty(globalThis, 'Image', previousImage);
    else delete (globalThis as { Image?: unknown }).Image;
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: class {
      width = 128;
      height = 64;
      onload?: () => void;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  });
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/views/current'))
      return Response.json({
        schemaVersion: 1,
        viewId: 'a'.repeat(64),
        mode: 'server',
        sourceScope: 'sky-fixture',
        generation: 0,
        renderRoot: 'b'.repeat(64),
      });
    if (url.endsWith('/resolve')) {
      const { selectors } = JSON.parse(init!.body as string);
      const id = selectors[0].id;
      ids.push(id);
      if (busy && id.endsWith('/celestial/sun')) {
        busy = false;
        return Response.json({ code: 'RESOURCE_BUSY', message: 'busy', retryable: true }, { status: 503 });
      }
      return Response.json({
        viewId: 'a'.repeat(64),
        validUntil: Date.now() + 30_000,
        resources: selectors.map((selector: { id: string }) =>
          mode === 'absent' || selector.id.endsWith('/full_moon')
            ? { selector, missing: true }
            : {
                selector,
                resource: {
                  schemaVersion: 1,
                  kind: 'texture',
                  url: 'https://sky.example/selected',
                  artifact: {
                    digest: mode === 'invalid' ? 'f'.repeat(64) : digest,
                    bytes: bytes.length,
                    mediaType: 'image/png',
                    format: 'png',
                  },
                },
              },
        ),
      });
    }
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  });
  const signal = new AbortController().signal;
  const loading = loadSkyTextures(signal);
  await setImmediate();
  assert.equal(ids.filter((id) => id.endsWith('/celestial/sun')).length, 1);
  assert.equal(ids.includes('minecraft:environment/sun'), false, 'busy work must not select another layout');
  t.mock.timers.tick(250);
  const sky = await loading;
  assert.equal(sky.sun!.id, 'minecraft:environment/celestial/sun');
  assert.equal(sky.moon!.id, 'minecraft:environment/moon_phases');
  assert.equal(sky.moon!.layout, 'moon-sheet');
  mode = 'absent';
  assert.deepEqual(await loadSkyTextures(signal), { sun: null, moon: null });
  mode = 'invalid';
  resourceDownloader.clear();
  ids.length = 0;
  await assert.rejects(loadSkyTextures(signal), { code: 'RESOURCE_INTEGRITY_FAILED' });
  assert.equal(ids.includes('minecraft:environment/sun'), false);
});
