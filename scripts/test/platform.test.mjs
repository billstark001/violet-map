import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execute, stopProcess } from '../helpers/process.mjs';
import { canonicalPath, isWithinDirectory } from '../helpers/filesystem.mjs';

test('filesystem containment handles drive roots, sibling names and directory aliases without creating paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    alias = path.join(root, 'alias');
  await fs.mkdir(source);
  await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(alias, 'missing', 'snapshot');
  assert.equal(isWithinDirectory(source, await canonicalPath(target)), true);
  assert.equal(isWithinDirectory(source, path.join(root, 'source-sibling')), false);
  assert.equal(isWithinDirectory(path.parse(root).root, root), true);
  await assert.rejects(fs.stat(path.join(source, 'missing')), { code: 'ENOENT' });
});

test('package-manager subprocesses preserve paths and arguments without a command shell', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet tools & # '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = path.join(root, 'pnpm.cjs');
  await fs.writeFile(manager, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const previous = process.env.npm_execpath;
  t.after(() => {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  });
  process.env.npm_execpath = manager;
  const args = ['space path', 'a&b', '%PATH%', '$HOME', 'quote"text', '空间'];
  assert.deepEqual(JSON.parse((await execute('pnpm', args)).stdout), args);
});

test('supervised Node processes finish graceful IPC cleanup before their parent continues', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'closed');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs/promises';
    async function shutdown() {
      await fs.writeFile(process.argv[1], 'released');
      process.disconnect();
    }
    process.on('SIGTERM', shutdown);
    process.on('message', message => {
      if (message.type === 'violet-map:shutdown') void shutdown();
    });
    process.send('ready');
  `,
      marker,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  t.after(() => stopProcess(child));
  await once(child, 'message');
  await stopProcess(child);
  assert.equal(child.exitCode, 0);
  assert.equal(await fs.readFile(marker, 'utf8'), 'released');
  await stopProcess(child);
});

test('historical artifacts can finish their signal-based cleanup through the IPC adapter', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-legacy-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'closed');
  const child = spawn(
    process.execPath,
    [
      '--import',
      new URL('../acceptance/helpers/legacy-signals.mjs', import.meta.url).href,
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs/promises';
    const alive = setInterval(() => {}, 1000);
    process.once('SIGTERM', async () => {
      await fs.writeFile(process.argv[1], 'released');
      clearInterval(alive);
    });
    process.send('ready');
  `,
      marker,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  t.after(() => stopProcess(child));
  await once(child, 'message');
  const exited = once(child, 'exit');
  child.send({ type: 'violet-map:shutdown' });
  await exited;
  assert.equal(child.exitCode, 0);
  assert.equal(await fs.readFile(marker, 'utf8'), 'released');
});
