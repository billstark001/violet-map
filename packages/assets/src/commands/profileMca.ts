import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  argsReader,
  buildMesherResources,
  ensureLight,
  infoGetter,
  loadAssetBundleFromDirs,
  loadBlockInfo,
  loadRegionColumns,
  makeColorOf,
  makeNeighborhood,
  numberArg,
  printSummaryTable,
  profileFullColumn,
  profileLodColumn,
  required,
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

function usage(): string {
  return `Usage:
  vm-assets profile-mca <file.mca> [--limit <n>] [--rounds <n>] [--center <cx,cz>] [--no-sky]
                            [--assets-dir <dir[,dir]>] [--block-info <file>] [--out <file>]`;
}

function parseOptions(args: string[]): ProfileOptions {
  const reader = argsReader(args);
  const positional = args.find((arg) => !arg.startsWith('-'));
  const center = reader.get('--center', '0,0')!.split(',').map((v) => Number(v.trim()));
  if (!Number.isFinite(center[0]) || !Number.isFinite(center[1])) throw new Error('center must be cx,cz');
  const assetDirs = reader.get('--assets-dir', '')!
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    region: resolvePath(required(reader.get('--region') ?? positional, 'mca file')),
    limit: Math.floor(numberArg(reader.get('--limit'), 64, 1)),
    rounds: Math.floor(numberArg(reader.get('--rounds'), 2, 1)),
    centerX: center[0],
    centerZ: center[1],
    hasSkyLight: !reader.flag('--no-sky'),
    out: reader.get('--out'),
    assetDirs,
    blockInfo: reader.get('--block-info'),
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

export async function runProfileMca(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  const opts = parseOptions(args);
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
    await fs.writeFile(out, `${JSON.stringify({
      region: opts.region,
      options: opts,
      setup: { totalMs: setupMs, parseMs, lightMs, columns: entries.size, selected: columns.length },
      summaries,
    }, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
}
