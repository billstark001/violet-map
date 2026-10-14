import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  buildMesherResources,
  ensureLight,
  infoGetter,
  loadAssetBundleFromDirs,
  loadBlockInfo,
  loadRegionColumns,
  makeColorOf,
  makeNeighborhood,
  printSummaryTable,
  profileFullColumn,
  profileLodColumn,
  resolvePath,
  summarize,
  timed,
  type ColumnEntry,
  type MeshStats,
  type TimedMeshStats,
} from './common.js';

interface ProfileOptions {
  region: string;
  limit: number;
  rounds: number;
  centerX: number;
  centerZ: number;
  hasSkyLight: boolean;
  out?: string;
  assetDirs: string[];
  blockInfo?: string;
}

export interface ProfileInput {
  region: string;
  limit?: number;
  rounds?: number;
  center?: string;
  sky?: boolean;
  out?: string;
  assetsDir?: string;
  blockInfo?: string;
}
function profileOptions(input: ProfileInput): ProfileOptions {
  const center = (input.center ?? '0,0').split(',').map(Number);
  if (center.length !== 2 || !center.every(Number.isFinite)) throw new Error('center must be cx,cz');
  return {
    region: resolvePath(input.region),
    limit: input.limit ?? 64,
    rounds: input.rounds ?? 2,
    centerX: center[0],
    centerZ: center[1],
    hasSkyLight: input.sky !== false,
    out: input.out,
    assetDirs: (input.assetsDir ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    blockInfo: input.blockInfo,
  };
}

function selectColumns(entries: Map<string, ColumnEntry>, opts: ProfileOptions) {
  return [...entries.values()]
    .map((entry) => entry.col)
    .filter((col) => [...col.sections.values()].some((section) => !section.isEmpty))
    .sort((a, b) => {
      const da = (a.x - opts.centerX) ** 2 + (a.z - opts.centerZ) ** 2;
      const db = (b.x - opts.centerX) ** 2 + (b.z - opts.centerZ) ** 2;
      return da - db;
    })
    .slice(0, opts.limit);
}

export async function runProfileMca(input: ProfileInput) {
  const opts = profileOptions(input);
  const setupStart = performance.now();
  const [blockInfo, bundle] = await Promise.all([
    loadBlockInfo(opts.blockInfo),
    opts.assetDirs.length ? loadAssetBundleFromDirs(opts.assetDirs) : Promise.resolve({ blockstates: {}, models: {} }),
  ]);
  const infoOf = infoGetter(blockInfo);
  const res = buildMesherResources(bundle, infoOf);
  const colorOf = makeColorOf(infoOf);
  const parseStart = performance.now();
  const entries = await loadRegionColumns(opts.region);
  const parseMs = performance.now() - parseStart;
  const lightStart = performance.now();
  for (const entry of entries.values()) ensureLight(entry, infoOf, opts.hasSkyLight);
  const lightMs = performance.now() - lightStart;
  const setupMs = performance.now() - setupStart;
  const columns = selectColumns(entries, opts);

  console.log(`region: ${opts.region}`);
  console.log(`columns parsed: ${entries.size}, selected: ${columns.length}, rounds: ${opts.rounds}`);
  console.log(`setup: ${setupMs.toFixed(2)}ms (parse ${parseMs.toFixed(2)}ms, light ${lightMs.toFixed(2)}ms)`);
  if (!opts.assetDirs.length) console.log('assets: none supplied; full mesh uses missing-cube fallback models');

  const samples = new Map<string, TimedMeshStats[]>();
  const addSample = (label: string, sample: TimedMeshStats) => {
    const list = samples.get(label) ?? [];
    list.push(sample);
    samples.set(label, list);
  };

  for (let round = 0; round < opts.rounds; round++) {
    for (const col of columns) {
      const hood = makeNeighborhood(entries, col);
      const full = timed(() => profileFullColumn(res, hood, col));
      addSample('full', { ...full.value, ms: full.ms });

      const height = timed<MeshStats>(() => {
        const total: MeshStats = { vertices: 0, indices: 0, sections: 0 };
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            col.heightAt(x, z);
            total.vertices++;
          }
        }
        return total;
      });
      addSample('height', { ...height.value, ms: height.ms });

      for (const step of [1, 2, 4, 8]) {
        const lod = timed(() => profileLodColumn(col, step, colorOf, opts.hasSkyLight, hood, infoOf));
        addSample(`lod${step}`, { ...lod.value, ms: lod.ms });
      }
    }
  }

  const summaries = [...samples.entries()].map(([label, values]) => summarize(label, values));
  printSummaryTable(summaries);

  if (opts.out) {
    const out = resolvePath(opts.out);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(
      out,
      `${JSON.stringify(
        {
          region: opts.region,
          options: opts,
          setup: { totalMs: setupMs, parseMs, lightMs, columns: entries.size, selected: columns.length },
          summaries,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nwrote ${out}`);
  }
}
