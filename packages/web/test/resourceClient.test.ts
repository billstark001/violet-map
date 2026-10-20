import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResourceClient } from '../src/resources/client.js';

function head(version: number, world = '') {
  const id = version.toString(16).repeat(64);
  return {
    schemaVersion: 1,
    mode: 'public',
    viewId: id,
    publicationId: id,
    sourceScope: world || 'root',
    generation: version,
    renderRoot: id,
  };
}

test('publication refresh commits all world heads before notification and retains the complete old set on failure', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let version = 1;
  let failWorld = false;
  globalThis.fetch = async (input) => {
    const world = new URL(String(input), 'http://fixture').searchParams.get('world') ?? '';
    if (world && failWorld) return Response.json({ code: 'RESOURCE_BACKEND_UNAVAILABLE' }, { status: 503 });
    return Response.json(head(version, world), { headers: { etag: `"${version}"` } });
  };
  const client = new ResourceClient();
  await client.head();
  await client.head('world');
  const events: number[] = [];
  const unsubscribe = client.subscribe((_previous, current) => {
    assert.equal(client.current()!.viewId, client.current('world')!.viewId);
    events.push(current.generation);
  });
  t.after(unsubscribe);
  version = 2;
  failWorld = true;
  await assert.rejects(client.refresh(), { code: 'RESOURCE_BACKEND_UNAVAILABLE' });
  assert.equal(client.current()!.generation, 1);
  assert.equal(client.current('world')!.generation, 1);
  assert.deepEqual(events, []);
  failWorld = false;
  await client.refresh();
  assert.deepEqual(events, [2, 2]);
  assert.throws(() => client.assertCurrent(head(1) as never), { code: 'RESOURCE_VIEW_EXPIRED' });
});

test('publication refresh rejects heads read on opposite sides of a commit', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let split = false;
  globalThis.fetch = async (input) => {
    const world = new URL(String(input), 'http://fixture').searchParams.get('world') ?? '';
    return Response.json(head(split ? (world ? 3 : 2) : 1, world));
  };
  const client = new ResourceClient();
  await client.head();
  await client.head('world');
  split = true;
  await assert.rejects(client.refresh(), { code: 'RESOURCE_VIEW_EXPIRED' });
  assert.equal(client.current()!.generation, 1);
  assert.equal(client.current('world')!.generation, 1);
});
