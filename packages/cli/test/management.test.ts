import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { managementFixture, serveManagement } from '../../server/test/helpers/management.js';
import { invoke } from './helpers.js';

test('login, users, credentials, and world sync use the same saved remote authorization', async (t) => {
  const fixture = await managementFixture(t);
  const { url, storage } = await serveManagement(t, fixture);
  const home = path.join(fixture.root, 'cli');
  await fs.mkdir(home);
  const run = (args: string[], input?: string, env?: NodeJS.ProcessEnv) =>
    invoke([...args, '--credential-store', 'file'], { home, input, env });
  await run(['profile', 'set', 'production', '--server-url', url]);
  await run(['profile', 'use', 'production']);
  const loggedIn = await run(['auth', 'login', '--username', 'operator', '--password-stdin'], 'operator-password\n');
  assert.doesNotMatch(loggedIn.stdout + loggedIn.stderr, /vm_|operator-password/);
  assert.equal(JSON.parse((await run(['auth', 'whoami'])).stdout).role, 'root');
  await run(['users', 'create', '--username', 'deploy_user', '--role', 'ci', '--password-stdin'], 'deploy-password\n');
  const credential = JSON.parse(
    (await run(['credentials', 'issue', '--username', 'deploy_user', '--expires-in', '600'])).stdout,
  );
  const archive = path.join(fixture.root, 'archive');
  await fs.mkdir(archive);
  await fs.writeFile(path.join(archive, 'level.dat'), 'world archive');
  const sync = ['world', 'sync', '--from', archive, '--world', 'survival', '--target', 'server'];
  await run(sync);
  assert.equal(Buffer.from((await storage.read('survival/level.dat'))!).toString(), 'world archive');
  const injected = { VIOLET_SERVER_URL: url, VIOLET_SERVER_TOKEN: credential.token };
  await assert.rejects(run(['users', 'list'], undefined, injected), /HTTP 403/);
  await run([...sync, '--dry-run'], undefined, injected);
  await run(['users', 'update', '--username', 'deploy_user', '--role', 'viewer']);
  await assert.rejects(run([...sync, '--dry-run'], undefined, injected), /HTTP 403/);
  await run(['credentials', 'revoke', '--username', 'deploy_user']);
  await assert.rejects(run(['auth', 'whoami'], undefined, injected), /HTTP 401/);
  await run(['users', 'delete', '--username', 'deploy_user']);
  await run(['auth', 'logout']);
  await assert.rejects(run(['users', 'list']), /No login/);
  const state = JSON.parse(await fs.readFile(path.join(home, 'state.json'), 'utf8'));
  assert.deepEqual(state.sessions, {});
  assert.deepEqual(state.secrets, {});
});
for (const driver of ['pglite', 'postgres'] as const) {
  test(
    `direct CLI uses the selected database and never runs maintenance (${driver})`,
    { skip: driver === 'postgres' && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const fixture = await managementFixture(t, driver);
      if (driver === 'pglite') await fixture.database.close();
      const home = path.join(fixture.root, 'cli');
      await fs.mkdir(home);
      const env = fixture.options.databaseUrl ? { DATABASE_URL: fixture.options.databaseUrl } : {};
      const target = driver === 'pglite' ? ['--database-dir', fixture.options.databaseDir] : [];
      const run = (args: string[], input?: string, extra: NodeJS.ProcessEnv = env) =>
        invoke(args, { home, input, env: extra });
      await assert.rejects(
        run(['users', 'list'], undefined, { DATABASE_DIR: fixture.options.databaseDir }),
        /server-url/,
      );
      await run(
        [
          'users',
          'create',
          '--via',
          'database',
          ...target,
          '--username',
          'local_admin',
          '--role',
          'admin',
          '--password-stdin',
        ],
        'local-password\n',
      );
      const list = JSON.parse((await run(['users', 'list', '--via', 'database', ...target])).stdout);
      assert.equal(list[0].username, 'local_admin');
      if (driver === 'pglite') {
        // An explicit directory wins over an unrelated PostgreSQL environment target.
        const local = await run(['users', 'list', '--via', 'database', ...target], undefined, {
          DATABASE_URL: 'postgresql://invalid:bad@127.0.0.1:1/unused',
        });
        assert.equal(JSON.parse(local.stdout)[0].username, 'local_admin');
        const empty = path.join(fixture.root, 'uninitialized');
        await assert.rejects(run(['users', 'list', '--via', 'database', '--database-dir', empty]), /db:migrate/);
        assert.equal((await fs.readdir(fixture.root)).includes('uninitialized.lock'), false);
      }
      await run(['users', 'delete', '--via', 'database', ...target, '--username', 'local_admin']);
    },
  );
}
