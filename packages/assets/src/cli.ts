#!/usr/bin/env node
/**
 * @violet-map/assets - Mojang asset extraction CLI
 *
 * Usage:
 *   pnpm vm-assets extract [--version 1.21.4] [--dir ./assets]
 *   pnpm vm-assets extract-all [--min-version 1.18] [--output ./assets]
 *   pnpm vm-assets list-versions
 *   pnpm vm-assets generate-biomes [--version 1.21.4] [--output ./biomes.json]
 *   pnpm vm-assets generate-dimensions [--version 1.21.4] [--output ./dimensions.json]
 *
 * Flow:
 *   1. Read the Mojang version manifest.
 *   2. Download the selected client jar.
 *   3. Extract assets/ content for blockstates, models, and textures.
 *   4. Generate biomes.json / dimensions.json with minecraft-data.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, cp as copy } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(childProcess.execFile);

// ---- 类型 ----
interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; time: string }[];
}
interface VersionInfo {
  id: string;
  downloads: { client: { url: string; sha1: string; size: number } };
  assetIndex?: { url: string; sha1: string; id: string };
}

// ---- 常量 ----
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const CACHE_DIR = resolve(process.env.HOME || process.env.USERPROFILE || '/tmp', '.vm-assets-cache');
const INVOCATION_CWD = process.env.INIT_CWD ?? process.cwd();

function resolveUserPath(file: string): string {
  return isAbsolute(file) ? file : resolve(INVOCATION_CWD, file);
}

// ---- 工具函数 ----
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
      console.log(`  Skip (cache hit): ${dest}`);
      return;
    }
    console.warn(`  Cache sha1 mismatch; redownloading: ${dest}`);
    if (!dryRun) await rm(dest, { force: true });
  }
  if (dryRun) {
    console.log(`  [dry-run] Download: ${url} -> ${dest}`);
    return;
  }
  console.log(`  Download: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  if (!res.body) throw new Error(`Empty response body: ${url}`);
  const fileStream = createWriteStream(dest);
  await pipeline(Readable.fromWeb(res.body as any), fileStream);
  if (expectedSha1) {
    const actual = await sha1File(dest);
    if (actual !== expectedSha1) throw new Error(`sha1 verification failed: ${dest} expected=${expectedSha1} actual=${actual}`);
  }
}

async function getManifest(): Promise<VersionManifest> {
  const cacheFile = join(CACHE_DIR, 'version_manifest_v2.json');
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    console.log('Fetching version manifest...');
    const m = await fetchJson<VersionManifest>(MANIFEST_URL);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(m));
    return m;
  }
}

async function getVersionInfo(versionId: string): Promise<VersionInfo> {
  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`Unknown version: ${versionId}. Use list-versions to inspect available versions.`);
  const cacheFile = join(CACHE_DIR, `${versionId}.json`);
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    console.log(`Fetching version metadata: ${versionId}`);
    const info = await fetchJson<VersionInfo>(entry.url);
    await writeFile(cacheFile, JSON.stringify(info));
    return info;
  }
}

// ---- 命令 ----
async function listVersions(includeSnapshots: boolean) {
  const manifest = await getManifest();
  const versions = includeSnapshots ? manifest.versions : manifest.versions.filter((v) => v.type === 'release');
  console.log(`Available versions (${includeSnapshots ? 'release + snapshot' : 'release only'}):`);
  for (const v of versions) {
    console.log(`  ${v.id} (${v.time.substring(0, 10)})`);
  }
  console.log(`\n${versions.length} versions total.`);
  if (!includeSnapshots) console.log('\nUse --include-snapshots to include snapshot versions.');
}

async function extractAssets(versionId: string, outputDir: string, dryRun = false) {
  const info = await getVersionInfo(versionId);
  const jarUrl = info.downloads.client.url;
  const jarPath = join(CACHE_DIR, `${versionId}.jar`);
  const assetsOutput = resolveUserPath(outputDir);
  const tmpOutput = join(CACHE_DIR, `${versionId}-extract`);

  await downloadFile(jarUrl, jarPath, info.downloads.client.sha1, dryRun);
  if (dryRun) {
    console.log(`  [dry-run] Extract assets/minecraft/* -> ${assetsOutput}/minecraft`);
    return;
  }

  // 使用 unzip 命令仅提取 assets/ 目录
  console.log(`Extracting assets/ from ${jarPath}...`);
  await mkdir(assetsOutput, { recursive: true });
  await rm(tmpOutput, { recursive: true, force: true });
  await mkdir(tmpOutput, { recursive: true });

  try {
    await execFile('unzip', ['-oq', jarPath, 'assets/minecraft/*', '-d', tmpOutput], { maxBuffer: 50 * 1024 * 1024 });
  } catch (e: any) {
    throw new Error(`unzip failed: ${e.message?.slice(0, 300) ?? e}`);
  }

  const srcDir = join(tmpOutput, 'assets', 'minecraft');
  if (!existsSync(srcDir)) throw new Error(`assets/minecraft was not found in jar: ${jarPath}`);
  await rm(join(assetsOutput, 'minecraft'), { recursive: true, force: true });
  await copy(srcDir, join(assetsOutput, 'minecraft'), { recursive: true, force: true });
  await rm(tmpOutput, { recursive: true, force: true });

  console.log(`\nAssets extracted to: ${assetsOutput}`);
  console.log(`   Layout: ${assetsOutput}/minecraft/{blockstates,models,textures}`);
  console.log(`   Environment example: ASSETS_DIRS=${assetsOutput}`);
}

async function extractAllAssets(minVersion: string, outputDir: string, includeSnapshots: boolean, dryRun = false) {
  const manifest = await getManifest();
  const versions = manifest.versions.filter((v) => {
    if (!includeSnapshots && v.type !== 'release') return false;
    // 简单版本比较（major.minor.patch）
    return compareVersions(v.id, minVersion) >= 0;
  });

  console.log(`Extracting ${versions.length} versions (>= ${minVersion})`);
  for (const v of versions) {
    console.log(`\n--- ${v.id} ---`);
    try {
      await extractAssets(v.id, join(outputDir, `minecraft-${v.id}`), dryRun);
    } catch (e) {
      console.error(`  Failed: ${(e as Error).message}`);
    }
  }
  console.log('\nDone.');
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
  outputFile = resolveUserPath(outputFile);
  // 使用 minecraft-data 中的 biome 信息生成 biomes.json
  const mcData = await importMinecraftData(versionId);

  const biomeMap: Record<string, any> = {
    default: { temperature: 0.8, downfall: 0.4,
      effects: { sky_color: 7907327, fog_color: 12638463, water_color: 4159204 } },
  };

  // minecraft-data 提供了 biomes 数组，包含 temperature, rainfall（即 downfall）, color 等
  if (mcData.biomesArray) {
    for (const b of mcData.biomesArray) {
      const id = `minecraft:${b.name}`;
      biomeMap[id] = {
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
  }

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(biomeMap, null, 2));
  console.log(`Generated biomes.json: ${outputFile} (${Object.keys(biomeMap).length} biomes)`);
}

async function generateDimensions(versionId: string, outputFile: string) {
  outputFile = resolveUserPath(outputFile);
  // 标准三个维度的定义
  const dimensions: Record<string, any> = {
    'minecraft:overworld': { hasSkyLight: true, ambientLight: 0.03, sky: 'normal', defaultBiome: 'minecraft:plains' },
    'minecraft:the_nether': { hasSkyLight: false, ambientLight: 0.25, sky: 'nether', defaultBiome: 'minecraft:nether_wastes' },
    'minecraft:the_end': { hasSkyLight: false, ambientLight: 0.18, sky: 'end', defaultBiome: 'minecraft:the_end' },
  };

  // 尝试从 minecraft-data 获取更多维度类型
  try {
    const mcData = await importMinecraftData(versionId);
    if (mcData.dimensionTypes) {
      for (const dim of mcData.dimensionTypes) {
        if (!dimensions[dim.name]) {
          dimensions[dim.name] = {
            hasSkyLight: dim.hasSkylight ?? true,
            ambientLight: dim.ambientLight ?? 0.03,
            sky: dim.name.includes('nether') ? 'nether' : dim.name.includes('end') ? 'end' : 'normal',
            defaultBiome: dim.defaultBiome ?? 'minecraft:plains',
          };
        }
      }
    }
  } catch { /* minecraft-data 可能没有 dimensionTypes */ }

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(dimensions, null, 2));
  console.log(`Generated dimensions.json: ${outputFile}`);
}

async function importMinecraftData(versionId: string): Promise<any> {
  try {
    const mcDataModule = await import('minecraft-data');
    return mcDataModule.default(versionId);
  } catch {
    console.error(`minecraft-data does not support ${versionId}; try a newer supported version.`);
    return { biomesArray: [], dimensions: [] };
  }
}

// ---- CLI 入口 ----
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const getArg = (names: string | string[], fallback: string): string => {
    const all = Array.isArray(names) ? names : [names];
    for (const name of all) {
      const idx = args.indexOf(name);
      if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
    }
    return fallback;
  };
  const hasFlag = (name: string): boolean => args.includes(name);

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(`Violet Map Asset CLI

Usage:
  pnpm vm-assets list-versions
    List all available release versions.

  pnpm vm-assets extract [--version <id>] [--dir <dir>] [--dry-run]
    Download the selected Mojang client jar and extract assets.
    --version: Minecraft version (default: 1.21.4)
    --dir:     Output directory (default: ./assets; --output is also accepted)

  pnpm vm-assets extract-all [--min-version <id>] [--dir <dir>] [--include-snapshots] [--dry-run]
    Extract assets for every release version >= the selected version.
    --min-version: Minimum version (default: 1.18)

  pnpm vm-assets generate-biomes [--version <id>] [--output <file>]
    Generate biomes.json with biome color data from minecraft-data.
    --output: Output file (default: ./biomes.json)

  pnpm vm-assets generate-dimensions [--version <id>] [--output <file>]
    Generate dimensions.json.
    --output: Output file (default: ./dimensions.json)

Examples:
  # Extract 1.21.4 assets into the server assets directory
  pnpm vm-assets extract --version 1.21.4 --dir ../server/data/assets

  # Generate biome data
  pnpm vm-assets generate-biomes --version 1.21.4 --output ../server/data-defaults/versions/1.21.4/biomes.json
`);
    return;
  }

  switch (command) {
    case 'list-versions':
      await listVersions(hasFlag('--include-snapshots'));
      break;
    case 'extract': {
      const version = getArg('--version', '1.21.4');
      const output = getArg(['--dir', '--output'], './assets');
      await extractAssets(version, output, hasFlag('--dry-run'));
      break;
    }
    case 'extract-all': {
      const minVersion = getArg('--min-version', '1.18');
      const output = getArg(['--dir', '--output'], './assets');
      await extractAllAssets(minVersion, output, hasFlag('--include-snapshots'), hasFlag('--dry-run'));
      break;
    }
    case 'generate-biomes': {
      const version = getArg('--version', '1.21.4');
      const output = getArg('--output', './biomes.json');
      await generateBiomes(version, output);
      break;
    }
    case 'generate-dimensions': {
      const version = getArg('--version', '1.21.4');
      const output = getArg('--output', './dimensions.json');
      await generateDimensions(version, output);
      break;
    }
    default:
      console.error(`Unknown command: ${command}. Use --help for usage.`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
