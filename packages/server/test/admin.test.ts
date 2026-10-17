import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createAdminContext, readAdminConfig } from '../src/admin.js';
import { connectDatabase } from '../src/db/connection.js';
import { managementFixture } from './helpers/management.js';

for (const driver of ['pglite', 'postgres'] as const) {
  test(
    `management service and direct operator share business rules (${driver})`,
    { skip: driver === 'postgres' && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const fixture = await managementFixture(t, driver);
      if (driver === 'pglite') await fixture.database.close();
      const direct = await createAdminContext({
        ...fixture.options,
        rootUsername: 'operator',
        rootPassword: 'operator-password',
      });
      try {
        await direct.users.create({ username: 'test_user', password: 'first-password', role: 'viewer' });
        await assert.rejects(
          direct.users.create({ username: 'test_user', password: 'first-password', role: 'viewer' }),
          /already exists/,
        );
        await assert.rejects(
          direct.users.create({ username: 'reserved', password: 'first-password', role: 'root' as 'admin' }),
          /reserved roles/,
        );
        await assert.rejects(direct.users.delete('operator'), /cannot be deleted/);
        const credential = await direct.credentials.issue('test_user', 3600);
        assert.equal(credential.user.username, 'test_user');
        await direct.users.update('test_user', { enabled: false });
        assert.equal((await direct.users.list()).find((u) => u.username === 'test_user')?.enabled, false);
        await direct.users.delete('test_user');
        assert.equal((await direct.users.list()).length, 1);
        if (driver === 'pglite') await assert.rejects(createAdminContext(fixture.options), /locked/);
      } finally {
        await direct.close();
      }
    },
  );
}

test('direct business context never initializes or migrates an unversioned database', async (t) => {
  const fixture = await managementFixture(t);
  const options = { databaseDir: path.join(fixture.root, 'uninitialized') };
  await assert.rejects(createAdminContext(options), /db:migrate/);
  const database = await connectDatabase(options);
  try {
    const rows = await database.query("select to_regclass('public.users') as users");
    assert.equal(rows[0].users, null);
  } finally {
    await database.close();
  }
  const api = await import('../src/admin.js');
  assert.deepEqual(Object.keys(api).sort(), ['createAdminContext', 'readAdminConfig']);
});

test('direct configuration has an explicit target and resolves YAML relative to its file', async (t) => {
  const fixture = await managementFixture(t);
  await assert.rejects(async () => readAdminConfig({ env: {}, cwd: fixture.root }), /requires/);
  const configuration = path.join(fixture.root, 'settings/violet-map.yaml');
  await fs.mkdir(path.dirname(configuration));
  await fs.writeFile(configuration, 'data:\n  dir: ../deployment\n');
  assert.equal(
    readAdminConfig({ env: {}, cwd: '/', configFile: configuration }).databaseDir,
    path.join(fixture.root, 'deployment/users.pglite'),
  );
});
