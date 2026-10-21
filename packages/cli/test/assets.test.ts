import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { extractMinecraftAssets } from '../src/commands/assetArchive.js';

function jar(entries: [string, string][]): Uint8Array {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const filename = Buffer.from(name),
      data = Buffer.from(contents);
    const header = Buffer.alloc(30),
      record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(offset, 42);
    local.push(header, filename, data);
    central.push(record, filename);
    offset += header.length + filename.length + data.length;
  }
  const index = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

test('JAR extraction needs no system unzip and handles spaces and Unicode while rejecting unsafe entries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'violet archive & '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'client # 空间.jar'),
    output = path.join(root, 'output');
  await writeFile(
    archive,
    jar([
      ['assets/minecraft/models/block/stone.json', '{}'],
      ['assets/minecraft/textures/空间.png', 'pixels'],
      ['META-INF/MANIFEST.MF', 'ignored'],
      ['assets/other/models/block/stone.json', 'ignored'],
    ]),
  );
  await extractMinecraftAssets(archive, output);
  assert.equal(await readFile(path.join(output, 'assets/minecraft/models/block/stone.json'), 'utf8'), '{}');
  assert.equal(await readFile(path.join(output, 'assets/minecraft/textures/空间.png'), 'utf8'), 'pixels');
  assert.deepEqual(await readdir(output), ['assets']);
  assert.deepEqual(await readdir(path.join(output, 'assets')), ['minecraft']);
  await writeFile(archive, jar([['assets/minecraft/../../../outside', 'escape']]));
  await assert.rejects(extractMinecraftAssets(archive, output), /invalid relative path/);
  await assert.rejects(readFile(path.join(root, 'outside')), { code: 'ENOENT' });
});

test('asset downloads stay atomic and extract-all includes later snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'violet-assets-download-'));
  const previousFetch = globalThis.fetch;
  try {
    const cache = path.join(root, 'cache');
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
    const { assetCommands } = await import('../src/commands/assets.js');
    const commands = assetCommands(cache);
    await assert.rejects(commands.extract('test-version', path.join(root, 'out')), /sha1 verification failed/);
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
    await assert.rejects(commands.extract('test-version', path.join(root, 'out')), /asset archive extraction failed/);
    assert.equal(await readFile(jar, 'utf8'), replacement);
    assert.equal(
      (await readdir(cache)).some((name) => name.includes('-extract-')),
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
      await commands.extractAll('1.18', path.join(root, 'out'), true, true);
    } finally {
      console.log = previousLog;
    }
    assert.match(logs.join('\n'), /Extracting 3 versions/);
    assert.match(logs.join('\n'), /22w01a/);
    assert.doesNotMatch(logs.join('\n'), /21w44a/);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});
