import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);

async function fixture(t, versions) {
  const root = await mkdtemp(join(tmpdir(), 'violet-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'packages'));
  await copyFile(new URL('../version.mjs', import.meta.url), join(root, 'scripts/version.mjs'));
  const files = [];
  for (const [name, version] of Object.entries(versions)) {
    const directory = name === 'workspace' ? root : join(root, 'packages', name);
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'package.json');
    await writeFile(file, JSON.stringify({ name: `@violet-map/${name}`, version, private: true }));
    files.push(file);
  }
  return {
    files,
    run: (...args) => exec(process.execPath, [join(root, 'scripts/version.mjs'), ...args], { cwd: tmpdir() }),
  };
}

test('version checks allow package patches and stable minor versions to differ', async (t) => {
  const development = await fixture(t, { workspace: '0.3.0', cli: '0.3.1', web: '0.3.0-rc.1' });
  await development.run();
  const stable = await fixture(t, { workspace: '1.0.0', cli: '1.4.2+build.3' });
  await stable.run();
});

test('version checks reject missing versions and incompatible release lines', async (t) => {
  for (const version of [undefined, '0.4.0', '1.3.0', '0.3.01', '0.3.0-rc.01', '0.3.0\n']) {
    const workspace = await fixture(t, { workspace: '0.3.0', cli: version });
    await assert.rejects(workspace.run(), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /packages\/cli\/package\.json/);
      return true;
    });
  }
});

test('coordinated updates include the root and every discovered package', async (t) => {
  const workspace = await fixture(t, { workspace: '0.3.0', cli: '0.3.1', future: '0.3.0' });
  await workspace.run('--set', '0.4.0-rc.1');
  await workspace.run();
  for (const file of workspace.files) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(data.version, '0.4.0-rc.1');
    assert.equal(data.private, true);
  }
});

test('invalid update requests leave every manifest unchanged', async (t) => {
  const workspace = await fixture(t, { workspace: '0.3.0', cli: '0.3.1' });
  const before = await Promise.all(workspace.files.map((file) => readFile(file, 'utf8')));
  for (const args of [
    ['--set', 'v0.4.0'],
    ['--set'],
    ['--set', '0.4.0', 'extra'],
    ['--set', '0.3.2', '--package'],
    ['--set', '--package', '@violet-map/cli'],
    ['--set', '0.3.2', '--package', '@violet-map/cli', '--package', '@violet-map/cli'],
    ['--set', '0.3.2', '--package', '@violet-map/missing'],
    ['--set', '0.3.2', '--unknown'],
    ['--package', '@violet-map/cli'],
  ])
    await assert.rejects(workspace.run(...args));
  assert.deepEqual(await Promise.all(workspace.files.map((file) => readFile(file, 'utf8'))), before);
});

test('targeted patch updates preserve the root and all other manifests byte for byte', async (t) => {
  for (const args of [
    ['--set', '0.3.2', '--package', '@violet-map/cli'],
    ['--set', '--package', '@violet-map/cli', '0.3.2'],
  ]) {
    const workspace = await fixture(t, { workspace: '0.3.0', cli: '0.3.1', web: '0.3.0' });
    const before = await Promise.all(workspace.files.map((file) => readFile(file, 'utf8')));
    await workspace.run(...args);
    await workspace.run();
    const after = await Promise.all(workspace.files.map((file) => readFile(file, 'utf8')));
    assert.equal(after[0], before[0]);
    assert.equal(after[2], before[2]);
    assert.deepEqual(JSON.parse(after[1]), { ...JSON.parse(before[1]), version: '0.3.2' });
  }
});

test('targeted incompatible updates reject without writing any manifests', async (t) => {
  const workspace = await fixture(t, { workspace: '0.3.0', cli: '0.3.1', web: '0.3.0' });
  const before = await Promise.all(workspace.files.map((file) => readFile(file, 'utf8')));
  for (const [version, name] of [
    ['0.4.0', '@violet-map/cli'],
    ['1.0.0', '@violet-map/cli'],
    ['0.4.0', '@violet-map/workspace'],
  ]) {
    await assert.rejects(workspace.run('--set', version, '--package', name), (error) => {
      assert.match(error.stderr, /does not share the workspace release line/);
      return true;
    });
    assert.deepEqual(await Promise.all(workspace.files.map((file) => readFile(file, 'utf8'))), before);
  }
});

test('targeted updates allow stable minor changes but reject a different major', async (t) => {
  const workspace = await fixture(t, { workspace: '1.0.0', cli: '1.2.0' });
  await workspace.run('--set', '1.3.0-rc.1', '--package', '@violet-map/cli');
  const before = await Promise.all(workspace.files.map((file) => readFile(file, 'utf8')));
  await assert.rejects(workspace.run('--set', '2.0.0', '--package', '@violet-map/cli'));
  assert.deepEqual(await Promise.all(workspace.files.map((file) => readFile(file, 'utf8'))), before);
});

test('a targeted update also validates untouched package versions before writing', async (t) => {
  const workspace = await fixture(t, { workspace: '0.3.0', cli: '0.3.1', web: '0.4.0' });
  const before = await Promise.all(workspace.files.map((file) => readFile(file, 'utf8')));
  await assert.rejects(workspace.run('--set', '0.3.2', '--package', '@violet-map/cli'));
  assert.deepEqual(await Promise.all(workspace.files.map((file) => readFile(file, 'utf8'))), before);
});
