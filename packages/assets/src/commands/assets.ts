import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp as copy, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as childProcess from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { argsReader, resolvePath } from './common.js';

const execFile = promisify(childProcess.execFile);
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const CACHE_DIR = resolve(process.env.HOME || process.env.USERPROFILE || '/tmp', '.vm-assets-cache');

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; time: string }[];
}

interface VersionInfo {
  id: string;
  downloads: { client: { url: string; sha1: string; size: number } };
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

async function sha1File(file: string): Promise<string> {
  const hash = createHash('sha1');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function downloadFile(url: string, dest: string, expectedSha1?: string, dryRun = false): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (existsSync(dest)) {
    if (!expectedSha1 || await sha1File(dest) === expectedSha1) {
      console.log(`  Skip cache hit: ${dest}`);
      return;
    }
    console.warn(`  Cache sha1 mismatch; redownloading: ${dest}`);
    if (!dryRun) await rm(dest, { force: true });
  }
  if (dryRun) {
    console.log(`  dry-run download: ${url} -> ${dest}`);
    return;
  }
  console.log(`  Download: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  if (!res.body) throw new Error(`empty response body: ${url}`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
  if (expectedSha1) {
    const actual = await sha1File(dest);
    if (actual !== expectedSha1) throw new Error(`sha1 verification failed: ${dest} expected=${expectedSha1} actual=${actual}`);
  }
}

async function getManifest(): Promise<VersionManifest> {
  const cacheFile = join(CACHE_DIR, 'version_manifest_v2.json');
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8')) as VersionManifest;
  } catch {
    console.log('Fetching version manifest...');
    const manifest = await fetchJson<VersionManifest>(MANIFEST_URL);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(manifest));
    return manifest;
  }
}

async function getVersionInfo(versionId: string): Promise<VersionInfo> {
  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`unknown version: ${versionId}`);
  const cacheFile = join(CACHE_DIR, `${versionId}.json`);
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8')) as VersionInfo;
  } catch {
    console.log(`Fetching version metadata: ${versionId}`);
    const info = await fetchJson<VersionInfo>(entry.url);
    await writeFile(cacheFile, JSON.stringify(info));
    return info;
  }
}

async function listVersions(includeSnapshots: boolean) {
  const manifest = await getManifest();
  const versions = includeSnapshots ? manifest.versions : manifest.versions.filter((v) => v.type === 'release');
  for (const v of versions) console.log(`${v.id}\t${v.type}\t${v.time.substring(0, 10)}`);
  console.log(`\n${versions.length} versions`);
}

async function extractAssets(versionId: string, outputDir: string, dryRun = false) {
  const info = await getVersionInfo(versionId);
  const jarPath = join(CACHE_DIR, `${versionId}.jar`);
  const assetsOutput = resolvePath(outputDir);
  const tmpOutput = join(CACHE_DIR, `${versionId}-extract`);

  await downloadFile(info.downloads.client.url, jarPath, info.downloads.client.sha1, dryRun);
  if (dryRun) {
    console.log(`  dry-run extract assets/minecraft/* -> ${assetsOutput}/minecraft`);
    return;
  }

  console.log(`Extracting assets from ${jarPath}...`);
  await mkdir(assetsOutput, { recursive: true });
  await rm(tmpOutput, { recursive: true, force: true });
  await mkdir(tmpOutput, { recursive: true });

  try {
    await execFile('unzip', ['-oq', jarPath, 'assets/minecraft/*', '-d', tmpOutput], { maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    throw new Error(`unzip failed: ${(e as Error).message}`);
  }

  const srcDir = join(tmpOutput, 'assets', 'minecraft');
  if (!existsSync(srcDir)) throw new Error(`assets/minecraft was not found in jar: ${jarPath}`);
  await rm(join(assetsOutput, 'minecraft'), { recursive: true, force: true });
  await copy(srcDir, join(assetsOutput, 'minecraft'), { recursive: true, force: true });
  await rm(tmpOutput, { recursive: true, force: true });

  console.log(`Assets extracted to: ${assetsOutput}`);
}

async function extractAllAssets(minVersion: string, outputDir: string, includeSnapshots: boolean, dryRun = false) {
  const manifest = await getManifest();
  const versions = manifest.versions.filter((v) => (includeSnapshots || v.type === 'release') && compareVersions(v.id, minVersion) >= 0);
  console.log(`Extracting ${versions.length} versions >= ${minVersion}`);
  for (const v of versions) {
    console.log(`\n--- ${v.id} ---`);
    try {
      await extractAssets(v.id, join(outputDir, `minecraft-${v.id}`), dryRun);
    } catch (e) {
      console.error(`  Failed: ${(e as Error).message}`);
    }
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function generateBiomes(versionId: string, outputFile: string) {
  const output = resolvePath(outputFile);
  const mcData = await importMinecraftData(versionId);
  const biomeMap: Record<string, unknown> = {
    default: {
      temperature: 0.8,
      downfall: 0.4,
      effects: { sky_color: 7907327, fog_color: 12638463, water_color: 4159204 },
    },
  };
  for (const b of mcData.biomesArray ?? []) {
    biomeMap[`minecraft:${b.name}`] = {
      temperature: b.temperature ?? 0.5,
      downfall: b.rainfall ?? 0.5,
      effects: {
        sky_color: b.color ?? 7907327,
        fog_color: 12638463,
        water_color: 4159204,
        ...(b.name === 'swamp' ? { foliage_color: 6975545, grass_color_modifier: 'swamp' } : {}),
        ...(b.name === 'mangrove_swamp' ? { foliage_color: 9285927, grass_color_modifier: 'swamp' } : {}),
        ...(b.name === 'dark_forest' ? { grass_color_modifier: 'dark_forest' } : {}),
        ...(b.name === 'badlands' || b.name === 'wooded_badlands' ? { grass_color: 9470285, foliage_color: 10387789 } : {}),
        ...(b.name === 'cherry_grove' ? { grass_color: 11983713, foliage_color: 11983713 } : {}),
      },
    };
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(biomeMap, null, 2)}\n`);
  console.log(`Generated biomes: ${output}`);
}

async function generateDimensions(versionId: string, outputFile: string) {
  const output = resolvePath(outputFile);
  const dimensions: Record<string, unknown> = {
    'minecraft:overworld': { hasSkyLight: true, ambientLight: 0.03, sky: 'normal', defaultBiome: 'minecraft:plains' },
    'minecraft:the_nether': { hasSkyLight: false, ambientLight: 0.25, sky: 'nether', defaultBiome: 'minecraft:nether_wastes' },
    'minecraft:the_end': { hasSkyLight: false, ambientLight: 0.18, sky: 'end', defaultBiome: 'minecraft:the_end' },
  };
  try {
    const mcData = await importMinecraftData(versionId);
    for (const dim of mcData.dimensionTypes ?? []) {
      if (dimensions[dim.name]) continue;
      dimensions[dim.name] = {
        hasSkyLight: dim.hasSkylight ?? true,
        ambientLight: dim.ambientLight ?? 0.03,
        sky: dim.name.includes('nether') ? 'nether' : dim.name.includes('end') ? 'end' : 'normal',
        defaultBiome: dim.defaultBiome ?? 'minecraft:plains',
      };
    }
  } catch {
    // minecraft-data does not expose dimensionTypes for every version.
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(dimensions, null, 2)}\n`);
  console.log(`Generated dimensions: ${output}`);
}

async function importMinecraftData(versionId: string): Promise<any> {
  const mcDataModule = await import('minecraft-data');
  return mcDataModule.default(versionId);
}

export function assetsUsage(): string {
  return `Usage:
  vm-assets assets list [--include-snapshots]
  vm-assets assets extract --version <id> --dir <dir> [--dry-run]
  vm-assets assets extract-all --min-version <id> --dir <dir> [--include-snapshots] [--dry-run]
  vm-assets assets generate-biomes --version <id> --output <file>
  vm-assets assets generate-dimensions --version <id> --output <file>`;
}

export async function runAssetsCommand(args: string[]) {
  const command = args[0];
  const reader = argsReader(args);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(assetsUsage());
    return;
  }
  switch (command) {
    case 'list':
      await listVersions(reader.flag('--include-snapshots'));
      break;
    case 'extract':
      await extractAssets(reader.get('--version', '1.21.4')!, reader.get('--dir', './assets')!, reader.flag('--dry-run'));
      break;
    case 'extract-all':
      await extractAllAssets(
        reader.get('--min-version', '1.18')!,
        reader.get('--dir', './assets')!,
        reader.flag('--include-snapshots'),
        reader.flag('--dry-run'),
      );
      break;
    case 'generate-biomes':
      await generateBiomes(reader.get('--version', '1.21.4')!, reader.get('--output', './biomes.json')!);
      break;
    case 'generate-dimensions':
      await generateDimensions(reader.get('--version', '1.21.4')!, reader.get('--output', './dimensions.json')!);
      break;
    default:
      throw new Error(`unknown assets command: ${command}`);
  }
}
