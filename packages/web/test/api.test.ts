import { encode } from '@msgpack/msgpack';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { resolveChunks, readChunks } from '../src/api.js';
import { resourceClient } from '../src/resources/client.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('chunk selectors preserve dimensions with path separators and one exact verified format', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const bytes = encode({ schemaVersion: 1, cx: 0, cz: 0, data: new Uint8Array([1]) });
  const head = {
    schemaVersion: 1,
    viewId: 'a'.repeat(64),
    mode: 'server',
    sourceScope: 'fixture',
    generation: 0,
    renderRoot: 'b'.repeat(64),
  };
  const selectors: unknown[] = [];
  let bodies = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/views/current')) return Response.json(head);
    if (url.endsWith('/resolve')) {
      const body = JSON.parse(init!.body as string);
      selectors.push(...body.selectors);
      return Response.json({
        viewId: head.viewId,
        validUntil: Date.now() + 30000,
        resources: body.selectors.map((selector: unknown) => ({
          selector,
          contentDigest: 'c'.repeat(64),
          terrainDigest: 'd'.repeat(64),
          resource: {
            schemaVersion: 1,
            kind: 'chunk',
            artifact: {
              digest: hash(bytes),
              bytes: bytes.length,
              mediaType: 'application/msgpack',
              format: 'chunk-msgpack-v1',
            },
            url: 'https://resources.example/chunk',
          },
        })),
      });
    }
    bodies++;
    return new Response(bytes, { headers: { 'content-type': 'application/msgpack' } });
  };
  const coordinates = [{ cx: 0, cz: 0 }];
  const hashes = await resolveChunks('example', 'mod:sky/islands', coordinates);
  assert.equal(hashes[0].dimension, 'mod:sky/islands');
  assert.equal('contentDigest' in hashes[0] && hashes[0].contentDigest, 'c'.repeat(64));
  assert.equal(bodies, 0);
  const chunks = await readChunks(hashes);
  assert.deepEqual(chunks[0].data, new Uint8Array([1]));
  assert.equal(bodies, 1);
  assert.equal(selectors.length, 1, 'body reads reuse the exact resolved reference');
  assert.ok(selectors.every((s: any) => s.dimension === 'mod:sky/islands'));
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(readChunks(hashes.map((chunk) => ({ ...chunk, validUntil: 0 }))), {
    code: 'RESOURCE_VIEW_EXPIRED',
  });
  assert.equal(bodies, 1, 'expired references fail before downloading');
  globalThis.fetch = async () => Response.json({ ...head, viewId: 'e'.repeat(64), generation: 1 });
  await resourceClient.refresh();
  await assert.rejects(readChunks(hashes), { code: 'RESOURCE_VIEW_EXPIRED' });
  assert.equal(bodies, 1, 'a changed view cannot reuse an old chunk reference');
});
