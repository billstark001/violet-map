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

test('world navigation releases old heads and in-flight refresh cannot resurrect a released world', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let complete!: () => void;
  let blocked = false;
  let requests = 0;
  globalThis.fetch = async (input) => {
    requests++;
    const world = new URL(String(input), 'http://fixture').searchParams.get('world') ?? '';
    if (blocked && world)
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    return Response.json(head(1, world));
  };
  const client = new ResourceClient();
  await client.head();
  for (let i = 0; i < 32; i++) {
    const world = `world${i}`,
      release = client.retainWorld(world);
    await client.head(world);
    release();
    assert.equal(client.current(world), undefined);
  }
  const release = client.retainWorld('active');
  await client.head('active');
  blocked = true;
  const refreshing = client.refresh();
  release();
  complete();
  await refreshing;
  assert.equal(client.current('active'), undefined);
  blocked = false;
  const before = requests;
  await client.refresh();
  assert.equal(requests - before, 1);
});

test('unowned world heads are evicted while owned worlds respect the active head limit', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (input) =>
    Response.json(head(1, new URL(String(input), 'http://fixture').searchParams.get('world') ?? ''));
  const client = new ResourceClient();
  for (let i = 0; i < 32; i++) await client.head('idle' + i);
  assert.equal(client.current('idle0'), undefined);
  const owned = new ResourceClient();
  for (let i = 0; i < 16; i++) {
    owned.retainWorld('active' + i);
    await owned.head('active' + i);
  }
  await assert.rejects(owned.head('overflow'), { code: 'RESOURCE_BUSY' });
});

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

test('metadata waiters own cancellation independently and the last owner ends the shared transport', async (t) => {
  let finish!: (response: Response) => void;
  let transport!: AbortSignal;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_input, init) => {
    calls++;
    transport = init!.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const client = new ResourceClient();
  const controller = new AbortController();
  const first = client.head('shared', false, controller.signal);
  const second = client.head('shared');
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(transport.aborted, false, 'another owner still needs this metadata');
  finish(Response.json(head(1, 'shared')));
  assert.equal((await second).generation, 1);
  assert.equal(calls, 1);
  assert.equal(transport.aborted, true, 'the completed request has no remaining owners');
});

test('late canceled metadata cannot update the head cache or remove its replacement', async (t) => {
  const completions: ((response: Response) => void)[] = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => completions.push(resolve)));
  const client = new ResourceClient();
  const controller = new AbortController();
  const old = client.head('world', false, controller.signal);
  const job = [...Reflect.get(client, 'pending')][0];
  controller.abort();
  await assert.rejects(old, { name: 'AbortError' });
  const replacement = client.head('world');
  assert.equal(completions.length, 2);
  completions[0](Response.json(head(1, 'old')));
  await assert.rejects(job.promise, { name: 'AbortError' });
  assert.equal(client.current('world'), undefined);
  completions[1](Response.json(head(2, 'new')));
  assert.equal((await replacement).generation, 2);
  assert.equal((await client.head('world')).generation, 2);
  assert.equal(completions.length, 2);
});
