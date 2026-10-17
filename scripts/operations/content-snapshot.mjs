import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadServerConfig } from '../../packages/server/dist/src/configuration.js';
import { createObjectStorage } from '../../packages/storage/dist/factory.js';
import { ScopedStorage } from '../../packages/storage/dist/prefixed.js';
import {
  parseMapDocument,
  parseLayerDocument,
  parseMediaDocument,
  parseMediaVersion,
} from '../../packages/core/dist/overlays.js';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeKey = (key) =>
  typeof key === 'string' &&
  key.length > 0 &&
  !/[\\\0]/.test(key) &&
  !/^[A-Za-z]:/.test(key) &&
  key.split('/').every((part) => part && part !== '.' && part !== '..');
async function openMounts(configFile, env) {
  const config = loadServerConfig({ configFile: path.resolve(configFile), cwd: process.cwd(), env });
  const stores = new Map();
  const mounts = {};
  for (const name of ['worlds', 'content', 'blobs']) {
    const { backend, prefix } = config.storage.mounts[name],
      definition = config.storage.backends[backend];
    if (!stores.has(backend))
      stores.set(
        backend,
        await createObjectStorage(
          definition.driver === 'local' ? { kind: 'local', root: definition.root } : { ...definition, kind: 's3' },
        ),
      );
    mounts[name] = new ScopedStorage(stores.get(backend), prefix);
  }
  const locations = Object.fromEntries(
    Object.entries(config.storage.backends).map(([name, b]) => [
      name,
      b.driver === 'local'
        ? { driver: b.driver, root: b.root }
        : {
            driver: b.driver,
            bucket: b.bucket,
            endpoint: b.endpoint ? new URL(b.endpoint).origin : undefined,
            region: b.region,
          },
    ]),
  );
  return { mounts, locations, bindings: config.storage.mounts };
}
async function inventory(mounts) {
  const result = [];
  for (const name of ['content', 'blobs'])
    for (const file of await mounts[name].list()) {
      if (!safeKey(file.path)) throw new Error('storage contains an unsafe object key');
      result.push({ mount: name, key: file.path, bytes: file.size, etag: file.etag, modifiedAt: file.modifiedAt });
    }
  return result.sort((a, b) => `${a.mount}/${a.key}`.localeCompare(`${b.mount}/${b.key}`));
}
async function readObject(root, digest, bytes) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isSafeInteger(bytes) || bytes < 0)
    throw new Error('invalid backup object descriptor');
  const target = path.join(root, 'objects', digest),
    canonical = await fs.realpath(target),
    base = await fs.realpath(root);
  if (!canonical.startsWith(base + path.sep + 'objects' + path.sep) || !(await fs.lstat(target)).isFile())
    throw new Error('backup objects must be regular files inside the snapshot');
  const data = await fs.readFile(target);
  if (data.length !== bytes || hash(data) !== digest) throw new Error('backup object checksum/size mismatch');
  return data;
}
async function validateContent(entries, read) {
  const index = new Map(entries.map((entry) => [`${entry.mount}/${entry.key}`, entry])),
    maps = [],
    layerHeads = new Map();
  for (const entry of entries.filter((entry) => entry.mount === 'content')) {
    const text = await read(entry);
    let document;
    try {
      document = JSON.parse(Buffer.from(text).toString('utf8'));
    } catch {
      throw new Error('backup content contains invalid JSON');
    }
    if (/^maps\/[^/]+\.json$/.test(entry.key)) {
      const map = parseMapDocument(document);
      if (entry.key !== `maps/${map.mapId}.json`) throw new Error('backup map identity mismatch');
      maps.push(map);
    } else if (/^layers\/[^/]+\/revisions\/[^/]+\.json$/.test(entry.key)) {
      const layer = parseLayerDocument(document);
      if (entry.key !== `layers/${layer.layerId}/revisions/${layer.revision}.json`)
        throw new Error('backup layer identity mismatch');
      for (const f of layer.features)
        if (f.kind === 'media' && !index.has(`content/assets/${f.assetId}/versions/${f.versionId}.json`))
          throw new Error('backup lacks a referenced media version');
    } else if (/^layers\/[^/]+\/head\.json$/.test(entry.key)) {
      if (
        document.schemaVersion !== 1 ||
        typeof document.deleted !== 'boolean' ||
        !Number.isSafeInteger(document.revision) ||
        document.revision < 1 ||
        entry.key !== `layers/${document.layerId}/head.json` ||
        !index.has(`content/layers/${document.layerId}/revisions/${document.revision}.json`)
      )
        throw new Error('backup publication head is incomplete');
      layerHeads.set(document.layerId, document);
    } else if (/^assets\/[^/]+\/head\.json$/.test(entry.key)) {
      const asset = parseMediaDocument(document.document);
      if (
        document.schemaVersion !== 1 ||
        typeof document.deleted !== 'boolean' ||
        entry.key !== `assets/${asset.assetId}/head.json` ||
        !Array.isArray(document.retainedVersions) ||
        asset.versions.some((version) => !document.retainedVersions.includes(version)) ||
        document.retainedVersions.some(
          (version) => !index.has(`content/assets/${asset.assetId}/versions/${version}.json`),
        )
      )
        throw new Error('backup publication head is incomplete');
    } else if (/^assets\/[^/]+\/versions\/[^/]+\.json$/.test(entry.key)) {
      const version = parseMediaVersion(document),
        blob = index.get(`blobs/${version.blob}`);
      if (
        entry.key !== `assets/${version.assetId}/versions/${version.versionId}.json` ||
        !blob ||
        blob.sha256 !== version.digest ||
        blob.bytes !== version.bytes
      )
        throw new Error('backup lacks an intact referenced media blob');
    }
  }
  for (const map of maps)
    for (const binding of map.bindings)
      if (!layerHeads.has(binding.layerId) || layerHeads.get(binding.layerId).deleted)
        throw new Error('backup lacks a published bound layer');
  return maps;
}
export async function backupContent({ configFile, output, env = process.env, quiesced = false }) {
  if (!quiesced) throw new Error('stop all writers and pass --quiesced before making a snapshot');
  const root = path.resolve(output),
    { mounts, locations, bindings } = await openMounts(configFile, env);
  for (const name of ['worlds', 'content', 'blobs']) {
    const definition = locations[bindings[name].backend];
    if (definition.driver === 'local') {
      const source = path.resolve(definition.root, bindings[name].prefix);
      if (root === source || root.startsWith(source + path.sep))
        throw new Error('backup directory must be outside all source mounts');
    }
  }
  // A new private directory avoids replacing an earlier known-good backup.
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(path.join(root, 'objects'), { mode: 0o700 });
  const before = await inventory(mounts),
    entries = [];
  for (const file of before) {
    const data = await mounts[file.mount].read(file.key);
    if (!data || data.length !== file.bytes) throw new Error('source changed during backup');
    const sha256 = hash(data),
      target = path.join(root, 'objects', sha256);
    try {
      await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    entries.push({ mount: file.mount, key: file.key, bytes: data.length, sha256 });
  }
  if (JSON.stringify(before) !== JSON.stringify(await inventory(mounts)))
    throw new Error('source inventory changed; leave writers stopped and retry into a new directory');
  const maps = await validateContent(entries, (entry) => readObject(root, entry.sha256, entry.bytes)),
    worlds = [];
  for (const worldKey of [...new Set(maps.map((map) => map.worldKey).filter(Boolean))]) {
    const data = await mounts.worlds.read(`${worldKey}/.violet-map/identity.json`);
    worlds.push({ worldKey, identity: data ? JSON.parse(Buffer.from(data).toString('utf8')) : null });
  }
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    writerQuiesced: true,
    storage: { backends: locations, mounts: bindings },
    worlds,
    maps,
    entries,
  };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    snapshot: root,
    objects: entries.length,
    uniqueBlobs: new Set(entries.map((entry) => entry.sha256)).size,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    maps: maps.length,
  };
}
export async function restoreContent({ configFile, input, env = process.env, quiesced = false }) {
  if (!quiesced) throw new Error('stop all writers and pass --quiesced before restoring');
  const root = path.resolve(input),
    manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.writerQuiesced !== true ||
    !Array.isArray(manifest.entries) ||
    !Array.isArray(manifest.worlds)
  )
    throw new Error('unsupported or incomplete backup manifest');
  const entries = manifest.entries,
    seen = new Set();
  for (const entry of entries) {
    if (!['content', 'blobs'].includes(entry.mount) || !safeKey(entry.key) || seen.has(`${entry.mount}/${entry.key}`))
      throw new Error('unsafe or duplicate backup object');
    seen.add(`${entry.mount}/${entry.key}`);
    await readObject(root, entry.sha256, entry.bytes);
  }
  const maps = await validateContent(entries, (entry) => readObject(root, entry.sha256, entry.bytes));
  const { mounts } = await openMounts(configFile, env);
  if ((await inventory(mounts)).length)
    throw new Error('restore requires empty content and blobs mounts; select fresh locations in the target config');
  for (const map of maps)
    if (map.worldKey) {
      const original = manifest.worlds.find((world) => world.worldKey === map.worldKey);
      if (!original) throw new Error('backup lacks a registered world relation');
      // Missing/unverified sources remain so; a previously identified source must still be the same archive.
      if (!original.identity) continue;
      const bytes = await mounts.worlds.read(`${map.worldKey}/.violet-map/identity.json`);
      if (!bytes || JSON.parse(Buffer.from(bytes).toString('utf8')).id !== original.identity.id)
        throw new Error(
          'target world identity differs; restore the archive at its relative worldKey before restoring content',
        );
    }
  // Referenced blobs and immutable revisions precede heads/maps. All readers/writers must remain stopped.
  const priority = (entry) => (entry.mount === 'blobs' ? 0 : /(?:\/head\.json$|^maps\/)/.test(entry.key) ? 2 : 1);
  for (const entry of [...entries].sort((a, b) => priority(a) - priority(b)))
    await mounts[entry.mount].replace(entry.key, await readObject(root, entry.sha256, entry.bytes));
  const restored = await inventory(mounts);
  if (restored.length !== entries.length) throw new Error('restore inventory differs');
  for (const entry of entries)
    if (hash(await mounts[entry.mount].read(entry.key)) !== entry.sha256)
      throw new Error('restored object checksum mismatch');
  return { objects: entries.length, maps: maps.length, verified: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        output: { type: 'string' },
        input: { type: 'string' },
        'env-file': { type: 'string' },
        quiesced: { type: 'boolean', default: false },
      },
    });
    if (
      positionals.length !== 1 ||
      !['backup', 'restore'].includes(positionals[0]) ||
      !values.config ||
      !(positionals[0] === 'backup' ? values.output : values.input)
    )
      throw new Error(
        'Usage: content-snapshot.mjs backup|restore --config FILE --output DIR|--input DIR --quiesced [--env-file FILE]',
      );
    const env = {
      ...process.env,
      ...(values['env-file'] ? parseEnv(await fs.readFile(values['env-file'], 'utf8')) : {}),
    };
    const options = {
      configFile: values.config,
      output: values.output,
      input: values.input,
      quiesced: values.quiesced,
      env,
    };
    console.log(
      JSON.stringify(await (positionals[0] === 'backup' ? backupContent(options) : restoreContent(options)), null, 2),
    );
  } catch (error) {
    console.error(
      error instanceof Error &&
        /^(stop all writers|Usage:|restore requires|target world identity|backup |unsupported or incomplete|unsafe or duplicate|source |restored object|restore inventory)/.test(
          error.message,
        )
        ? error.message
        : 'Snapshot operation failed; backend details withheld to protect credentials.',
    );
    process.exitCode = 1;
  }
}
