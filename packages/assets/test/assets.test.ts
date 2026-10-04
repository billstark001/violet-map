import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('asset downloads stay atomic and extract-all includes later snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'violet-assets-download-'));
  const previousHome = process.env.HOME;
  const previousFetch = globalThis.fetch;
  process.env.HOME = root;
  try {
    const cache = path.join(root, '.vm-assets-cache');
    await mkdir(cache);
    await writeFile(
      path.join(cache, 'version_manifest_v2.json'),
      JSON.stringify({ versions: [{ id: 'test-version', url: 'https://example.test/version.json' }] }),
    );
    await writeFile(
      path.join(cache, 'test-version.json'),
      JSON.stringify({ downloads: { client: { url: 'https://example.test/client.jar', sha1: 'invalid' } } }),
    );
    const jar = path.join(cache, 'test-version.jar');
    await writeFile(jar, 'previous jar');
    globalThis.fetch = async () => new Response('replacement jar');
    const { runAssetsCommand } = await import('../src/commands/assets.js');
    await assert.rejects(
      runAssetsCommand(['extract', '--version', 'test-version', '--dir', path.join(root, 'out')]),
      /sha1 verification failed/,
    );
    assert.equal(await readFile(jar, 'utf8'), 'previous jar');
    assert.deepEqual(
      (await readdir(cache)).filter((name) => name.endsWith('.tmp')),
      [],
    );

    const replacement = 'replacement jar';
    await writeFile(
      path.join(cache, 'test-version.json'),
      JSON.stringify({
        downloads: {
          client: {
            url: 'https://example.test/client.jar',
            sha1: createHash('sha1').update(replacement).digest('hex'),
          },
        },
      }),
    );
    await assert.rejects(
      runAssetsCommand(['extract', '--version', 'test-version', '--dir', path.join(root, 'out')]),
      /unzip failed/,
    );
    assert.equal(await readFile(jar, 'utf8'), replacement);
    assert.equal(
      (await readdir(cache)).some((name) => name.endsWith('-extract')),
      false,
    );

    const versions = [
      {
        id: '21w44a',
        type: 'snapshot',
        time: '2022-09-01T00:00:00Z',
        releaseTime: '2021-11-01T00:00:00Z',
      },
      { id: '1.18', type: 'release', time: '2021-11-30T00:00:00Z' },
      { id: '22w01a', type: 'snapshot', time: '2022-01-05T00:00:00Z' },
      { id: '1.19', type: 'release', time: '2022-06-07T00:00:00Z' },
    ];
    await writeFile(path.join(cache, 'version_manifest_v2.json'), JSON.stringify({ versions }));
    for (const version of versions) {
      await writeFile(
        path.join(cache, `${version.id}.json`),
        JSON.stringify({ downloads: { client: { url: 'https://example.test/client.jar', sha1: 'unused' } } }),
      );
    }
    const logs: string[] = [];
    const previousLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      await runAssetsCommand([
        'extract-all',
        '--min-version',
        '1.18',
        '--dir',
        path.join(root, 'out'),
        '--include-snapshots',
        '--dry-run',
      ]);
    } finally {
      console.log = previousLog;
    }
    assert.match(logs.join('\n'), /Extracting 3 versions/);
    assert.match(logs.join('\n'), /22w01a/);
    assert.doesNotMatch(logs.join('\n'), /21w44a/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
