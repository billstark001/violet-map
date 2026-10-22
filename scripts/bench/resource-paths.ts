import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import type { PublicationManifest } from '../../packages/core/src/resources.js';
import { canonicalJson } from '../../packages/core/src/resources.js';
import { artifactRef, sha256 } from '../../packages/storage/src/contentAddressed.js';
import { PublicationStore } from '../../packages/resources/src/publication.js';
import { prepareTopMapRegion } from '../../packages/resources/src/topMapDependencies.js';
import { RevisionMemo } from '../../packages/resources/src/revisionMemo.js';

const sourceFiles = [
  'packages/resources/src/topMapDependencies.ts',
  'packages/resources/src/revisionMemo.ts',
  'packages/resources/src/publication.ts',
  'packages/resources/src/singleflight.ts',
  'packages/core/src/cache.ts',
  'packages/storage/src/contentAddressed.ts',
];
const fingerprint = async () =>
  sha256(
    canonicalJson(
      await Promise.all(sourceFiles.map(async (file) => [file, sha256(new Uint8Array(await fs.readFile(file)))])),
    ),
  );
const implementationDigest = await fingerprint();

// Deterministic inputs and operation counters accompany timings. No source world
// or provider is modified; this measures dependency preparation and public reads.
async function measure(name: string, run: () => Promise<void>) {
  for (let i = 0; i < 5; i++) await run();
  const times: number[] = [];
  const cpu = process.cpuUsage();
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  const used = process.cpuUsage(cpu);
  times.sort((a, b) => a - b);
  return { name, rounds: times.length, p50Ms: times[15], p95Ms: times[28], cpuUs: (used.user + used.system) / 30 };
}

let sourceCalls = 0;
const source = {
  async readChunks(_world: string, _dimension: string, positions: { cx: number; cz: number }[]) {
    sourceCalls++;
    return positions.map(({ cx, cz }) =>
      (cx + cz) % 5 === 0
        ? ({ data: new Uint8Array([cx & 255, cz & 255]), terrainDigest: sha256(`${cx},${cz}`) } as never)
        : null,
    );
  },
};
const expected = sha256(
  canonicalJson(
    Array.from({ length: 1024 }, (_, i) => {
      const cx = i % 32,
        cz = Math.floor(i / 32);
      return { cx, cz, digest: (cx + cz) % 5 === 0 ? sha256(`${cx},${cz}`) : null };
    }),
  ),
);
const topMap = await measure('top-map-region-dependencies', async () => {
  assert.equal((await prepareTopMapRegion(source, 'fixture', 'minecraft:overworld', 0, 0)).digest, expected);
});
const terrainMemo = new RevisionMemo(4096);
const beforeMemo = sourceCalls;
const hotTopMap = await measure('unchanged-top-map-dependencies', async () => {
  assert.equal(
    await terrainMemo.get(
      'region',
      async () => 'reliable-fixture-revision',
      async () => (await prepareTopMapRegion(source, 'fixture', 'minecraft:overworld', 0, 0)).digest,
    ),
    expected,
  );
});
const memoSourceCalls = sourceCalls - beforeMemo;

const manifest: PublicationManifest = {
  schemaVersion: 1,
  sourceScope: 'fixture',
  archiveIds: {},
  sourceScopes: {},
  renderRoot: 'a'.repeat(64),
  worlds: [],
  entries: Array.from({ length: 512 }, (_, i) => ({
    selector: { kind: 'texture', id: `minecraft:block/fixture_${i}` },
    artifact: artifactRef(new Uint8Array([i & 255]), 'image/png', 'png'),
    actionKey: sha256(String(i)),
  })),
  regions: [],
  coverage: {},
  topMaps: {},
  overlays: [],
};
const bytes = new TextEncoder().encode(canonicalJson(manifest));
const ref = artifactRef(bytes, 'application/json', 'publication-v1');
let manifestGets = 0;
const store = new PublicationStore({
  kind: 'http',
  async readRange() {
    manifestGets++;
    return bytes;
  },
} as never);
const head = { schemaVersion: 1 as const, publicationId: ref.digest, revision: 1, manifest: ref };
const publicRead = await measure('immutable-publication-read', async () => {
  assert.equal((await store.manifest(head)).entries.length, 512);
});

await store.close();

const report = {
  schemaVersion: 1,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  implementationDigest,
  sourceFiles,
  measuredAt: new Date().toISOString(),
  cases: [
    { ...topMap, sourceCalls: beforeMemo, outputDigest: expected },
    { ...publicRead, manifestGets, manifestBytes: bytes.length },
    { ...hotTopMap, sourceCalls: memoSourceCalls, outputDigest: expected },
  ],
};
const output = process.argv[2];

assert.equal(await fingerprint(), implementationDigest, 'microbenchmark implementation changed during the run');

if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify(report));
