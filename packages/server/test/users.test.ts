import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { eq } from 'drizzle-orm';
import { createDatabaseService } from '../src/db/index.js';
import { connectDatabase } from '../src/db/connection.js';
import { migrateDatabase } from '../src/db/migrations.js';
import { users } from '../src/db/schema.js';
import { createUserService } from '../src/users.js';

test('database initialization retries and password changes revoke existing credentials', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-users-'));
  const config = { databaseDir: '', databaseUrl: undefined };
  const { closeDatabase, getDatabase } = createDatabaseService(config);
  const { authenticateCredential, createUser, deleteUser, login, updateUser } = createUserService(getDatabase);
  const invalidDir = path.join(root, 'file');
  await fs.writeFile(invalidDir, 'not a directory');
  config.databaseUrl = undefined;
  config.databaseDir = invalidDir;
  t.after(async () => {
    await closeDatabase();
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(getDatabase());
  config.databaseDir = path.join(root, 'users.pglite');
  await assert.rejects(getDatabase(), /db:migrate/);
  const maintenance = await connectDatabase(config);
  try {
    await migrateDatabase(maintenance);
  } finally {
    await maintenance.close();
  }
  await getDatabase();

  await createUser({ username: 'test_user', password: 'first-password', role: 'viewer' });
  const credential = await login('test_user', 'first-password');
  assert.ok(credential);
  assert.equal((await authenticateCredential(credential.token))?.username, 'test_user');

  await updateUser('test_user', { password: 'second-password' });
  assert.equal(await authenticateCredential(credential.token), undefined);
  assert.equal(await login('test_user', 'first-password'), undefined);
  assert.ok(await login('test_user', 'second-password'));
  const { db } = await getDatabase();
  await db.update(users).set({ passwordHash: 'scrypt$bad$AA' }).where(eq(users.username, 'test_user'));
  assert.equal(await login('test_user', 'second-password'), undefined);
  await deleteUser('test_user');
  assert.equal(await login('test_user', 'second-password'), undefined);
});
