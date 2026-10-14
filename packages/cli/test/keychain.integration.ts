import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliPaths } from '../src/settings/paths.js';
import { SecretStore } from '../src/settings/secrets.js';
import { loadState } from '../src/settings/state.js';

// Explicit opt-in script: this file is intentionally outside the *.test.ts suite.
test('real system credential store lifecycle in an isolated temporary CLI home', async (t) => {
  const { AsyncEntry, findCredentialsAsync } = await import('@napi-rs/keyring');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-keychain-integration-'));
  const paths = cliPaths({ cliHome: root }, {});
  const service = `violet-map.cli.${paths.namespace}`;
  const accounts = new Set<string>();
  const entry = (account: string) => new AsyncEntry(service, account, { linux: { store: 'secret-service' } });

  t.after(async () => {
    // Only enumerate this test's random service, including a write that might
    // have succeeded before the application's metadata could be committed.
    const failures: unknown[] = [];
    try {
      for (const credential of await findCredentialsAsync(service)) accounts.add(credential.account);
    } catch (error) {
      failures.push(error);
    }
    for (const account of accounts) {
      try {
        await entry(account).deleteCredential();
        assert.ok((await entry(account).getPassword()) === null, 'Temporary credential remains after cleanup');
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      assert.equal((await findCredentialsAsync(service)).length, 0, 'Temporary service must contain no credentials');
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, `Keychain cleanup failed for isolated service ${service}; retained ${root}`);
    }
    await fs.rm(root, { recursive: true, force: true });
    t.diagnostic('Verified all temporary keychain entries deleted and temporary CLI home removed');
  });

  await t.test('native entry writes, reads, updates in place, and deletes', async () => {
    const account = `native-${randomUUID()}`;
    accounts.add(account);
    const credential = entry(account);
    const original = `original-${randomUUID()}`;
    const replacement = `replacement-${randomUUID()}-凭据`;
    assert.ok((await credential.getPassword()) === null, 'Temporary entry must start absent');
    await credential.setPassword(original);
    assert.ok((await entry(account).getPassword()) === original, 'Written secret must be readable by a new entry');
    await credential.setPassword(replacement);
    assert.ok((await entry(account).getPassword()) === replacement, 'Updated secret must replace the original');
    assert.equal(await credential.deleteCredential(), true);
    assert.ok((await entry(account).getPassword()) === null, 'Deleted entry must be absent');
    assert.equal(await credential.deleteCredential(), false);
  });

  await t.test('SecretStore replaces OS entries, keeps metadata secret-free, and deletes', async () => {
    const store = new SecretStore(paths, 'keychain', {});
    const name = `application-${randomUUID()}`;
    const original = `application-original-${randomUUID()}`;
    const replacement = `application-replacement-${randomUUID()}`;
    await store.set(name, original);
    const first = (await loadState(paths)).secrets[name];
    accounts.add(first.id);
    assert.equal(first.backend, 'keychain');
    assert.ok((await store.get(name)) === original, 'SecretStore must read the original secret');
    assert.ok((await entry(first.id).getPassword()) === original, 'Secret must exist in the real system store');

    await store.set(name, replacement);
    const second = (await loadState(paths)).secrets[name];
    accounts.add(second.id);
    assert.notEqual(first.id, second.id);
    assert.ok((await entry(first.id).getPassword()) === null, 'Replacement must remove the previous OS entry');
    assert.ok((await store.resolve(`secret:${name}`)) === replacement, 'Reference must resolve the updated secret');
    assert.ok((await entry(second.id).getPassword()) === replacement, 'Updated secret must exist in the system store');
    const metadata = await fs.readFile(paths.stateFile, 'utf8');
    assert.ok(!metadata.includes(original) && !metadata.includes(replacement), 'Metadata must not contain secrets');
    await assert.rejects(fs.access(paths.credentialFile), { code: 'ENOENT' });

    await store.delete(name);
    assert.ok((await entry(second.id).getPassword()) === null, 'Application deletion must remove the OS entry');
    assert.equal((await loadState(paths)).secrets[name], undefined);
    await assert.rejects(store.get(name), /Credential not found/);
    await store.delete(name);
  });
});
