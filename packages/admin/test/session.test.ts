import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdminSession, ApiError, authHeaders } from '../src/session.js';

const user = { id: 'one', username: 'alice', role: 'admin' };

function fixture(fetch: (path: string, init?: RequestInit) => Promise<Response>) {
  const storage = new Map<string, string>();
  const session = new AdminSession({
    mode: 'users',
    fetch,
    key: 'api-a',
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
  });
  return { session, storage };
}

test('session supports restricted storage, all HeadersInit forms and stable subscriptions', async () => {
  const session = new AdminSession({
    mode: 'static',
    fetch: async () => {
      throw new Error('not called');
    },
    key: 'k',
    storage: {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    },
  });
  let updates = 0;
  const unsubscribe = session.subscribe(() => {
    updates++;
  });
  const initial = session.getSnapshot();
  session.setToken('static');
  assert.notEqual(session.getSnapshot(), initial);
  await session.refresh();
  assert.equal(session.getSnapshot().token, 'static');
  await session.signOut();
  assert.equal(session.getSnapshot().token, '');
  unsubscribe();
  session.setToken('again');
  assert.equal(updates, 2);
  for (const input of [
    new Headers({ accept: 'application/json' }),
    [['accept', 'application/json']],
    { accept: 'application/json' },
  ] as HeadersInit[]) {
    assert.equal(authHeaders('t', input).get('accept'), 'application/json');
    assert.equal(authHeaders('t', input).get('authorization'), 'Bearer t');
  }
});

test('late identity and login responses never replace a newer manual credential', async () => {
  const pending: ((response: Response) => void)[] = [];
  const { session, storage } = fixture(async () => new Promise((resolve) => pending.push(resolve)));
  session.setToken('old');
  const refresh = session.refresh();
  session.setToken('new');
  pending.shift()!(Response.json(user));
  await refresh;
  assert.deepEqual(session.getSnapshot(), { token: 'new', user: null, error: null, busy: false });
  const login = session.signIn('alice', 'password');
  assert.equal(await session.signIn('alice', 'password'), false, 'duplicate submit does not send a second login');
  session.setToken('manual');
  pending.shift()!(Response.json({ token: 'late', user }));
  assert.equal(await login, false);
  assert.equal(storage.get('api-a'), 'manual');
});

test('logout clears local state immediately and does not clobber a replacement session', async () => {
  let finish!: (response: Response) => void;
  const { session, storage } = fixture(async (_path, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer old');
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  session.setToken('old');
  const logout = session.signOut();
  assert.equal(session.getSnapshot().token, '');
  assert.equal(storage.has('api-a'), false);
  session.setToken('new');
  finish(Response.json({ error: 'unavailable' }, { status: 503 }));
  await logout;
  assert.equal(session.getSnapshot().token, 'new');
  assert.equal(session.getSnapshot().error, null);
});

test('authenticated failures expire only the rejected credential; permission/network failures remain recoverable', async () => {
  let status = 401;
  const { session } = fixture(async () => new Response('proxy HTML error', { status }));
  session.setToken('invalid');
  await assert.rejects(
    session.request('api/admin/users'),
    (error) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(session.getSnapshot().token, '');
  session.setToken('valid');
  status = 403;
  await assert.rejects(session.request('api/admin/users'), /HTTP 403/);
  assert.equal(session.getSnapshot().token, 'valid');
  status = 503;
  assert.equal(await session.signIn('alice', 'password'), false);
  assert.match(session.getSnapshot().error!, /HTTP 503/);
  assert.equal(session.getSnapshot().busy, false);
});

test('a stale 401 cannot expire a newly reselected identical token', async () => {
  let finish!: (response: Response) => void;
  const { session } = fixture(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  session.setToken('same');
  const request = session.request('api/admin/users');
  session.setToken('other');
  session.setToken('same');
  finish(Response.json({ error: 'old rejection' }, { status: 401 }));
  await assert.rejects(request, ApiError);
  assert.equal(session.getSnapshot().token, 'same');
});
