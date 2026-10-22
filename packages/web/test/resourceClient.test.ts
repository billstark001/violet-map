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

test('initial world reads reject a mixed generation in both delivery modes', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const mode of ['server', 'public'] as const) {
    let version = 1;
    globalThis.fetch = async (input) => {
      const world = new URL(String(input), 'http://fixture').searchParams.get('world') ?? '';
      const value = head(version, world);
      return Response.json(
        mode === 'public'
          ? value
          : {
              schemaVersion: 1,
              mode,
              viewId: value.viewId + world,
              sourceScope: value.sourceScope,
              generation: version,
              renderRoot: value.renderRoot,
            },
      );
    };
    const client = new ResourceClient();
    const root = await client.head();
    version = 2;
    await assert.rejects(client.head('world'), { code: 'RESOURCE_VIEW_EXPIRED' });
    assert.equal(client.current('world'), undefined);
    assert.equal(client.current(), root);
    await client.refresh();
    assert.equal((await client.head('world')).generation, 2);
    client.assertCurrent(client.current('world')!, 'world');
  }
});

test('malformed HTTP error documents cannot inject arbitrary resource codes or retry policy', async (t) => {
  const documents = [
    { code: 'OLD_RESOURCE_ERROR', message: 'old', retryable: true },
    { code: 'RESOURCE_BUSY', message: 'busy', retryable: 'true' },
    { code: 'RESOURCE_BUSY' },
    null,
  ];
  for (const document of documents) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(document, { status: 503 }));
    await assert.rejects(new ResourceClient().head(), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'RESOURCE_BACKEND_UNAVAILABLE');
      assert.match((error as Error).message, /HTTP 503: invalid error document/);
      assert.equal((error as { retryable: boolean }).retryable, true);
      return true;
    });
  }
});
