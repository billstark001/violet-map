#!/usr/bin/env node
/**
 * @violet-map/assets — Mojang 官方资源提取 CLI
 *
 * 用法:
 *   pnpm vm-assets extract [--version 1.21.4] [--dir ./assets]
 *   pnpm vm-assets extract-all [--min-version 1.18] [--output ./assets]
 *   pnpm vm-assets list-versions
 *   pnpm vm-assets generate-biomes [--version 1.21.4] [--output ./biomes.json]
 *   pnpm vm-assets generate-dimensions [--version 1.21.4] [--output ./dimensions.json]
 *
 * 提取流程:
 *   1. 从 Mojang version manifest (https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
 *      获取版本列表。
 *   2. 根据 manifest 中的 client jar URL 下载 jar。
 *   3. 解压 jar 中的 assets/ 目录（blockstates、models、textures）。
 *   4. 使用 minecraft-data 生成 biomes.json / dimensions.json。
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
      console.log(`  跳过 (缓存命中): ${dest}`);
      return;
    }
    console.warn(`  缓存 sha1 不匹配，重新下载: ${dest}`);
    if (!dryRun) await rm(dest, { force: true });
  }
  if (dryRun) {
    console.log(`  [dry-run] 下载: ${url} -> ${dest}`);
    return;
  }
  console.log(`  下载: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  if (!res.body) throw new Error(`响应体为空: ${url}`);
  const fileStream = createWriteStream(dest);
  await pipeline(Readable.fromWeb(res.body as any), fileStream);
  if (expectedSha1) {
    const actual = await sha1File(dest);
    if (actual !== expectedSha1) throw new Error(`sha1 校验失败: ${dest} expected=${expectedSha1} actual=${actual}`);
  }
}

async function getManifest(): Promise<VersionManifest> {
  const cacheFile = join(CACHE_DIR, 'version_manifest_v2.json');
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    console.log('获取 version manifest...');
    const m = await fetchJson<VersionManifest>(MANIFEST_URL);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(m));
    return m;
  }
}

async function getVersionInfo(versionId: string): Promise<VersionInfo> {
  const manifest = await getManifest();
  const entry = manifest.versions.find((v) => v.id === versionId);
  if (!entry) throw new Error(`未知版本: ${versionId}。使用 list-versions 查看可用版本。`);
  const cacheFile = join(CACHE_DIR, `${versionId}.json`);
  try {
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  } catch {
    console.log(`获取版本信息: ${versionId}`);
    const info = await fetchJson<VersionInfo>(entry.url);
    await writeFile(cacheFile, JSON.stringify(info));
    return info;
  }
}

// ---- 命令 ----
async function listVersions(includeSnapshots: boolean) {
  const manifest = await getManifest();
  const versions = includeSnapshots ? manifest.versions : manifest.versions.filter((v) => v.type === 'release');
  console.log(`可用版本 (${includeSnapshots ? 'release + snapshot' : 'release only'}):`);
  for (const v of versions) {
    console.log(`  ${v.id} (${v.time.substring(0, 10)})`);
  }
  console.log(`\n共 ${versions.length} 个版本。`);
  if (!includeSnapshots) console.log(`\nsnapshot 版本可用 --include-snapshots 查看。`);
}

async function extractAssets(versionId: string, outputDir: string, dryRun = false) {
  const info = await getVersionInfo(versionId);
  const jarUrl = info.downloads.client.url;
  const jarPath = join(CACHE_DIR, `${versionId}.jar`);
  const assetsOutput = resolveUserPath(outputDir);
  const tmpOutput = join(CACHE_DIR, `${versionId}-extract`);

  await downloadFile(jarUrl, jarPath, info.downloads.client.sha1, dryRun);
  if (dryRun) {
    console.log(`  [dry-run] 提取 assets/minecraft/* -> ${assetsOutput}/minecraft`);
    return;
  }

  // 使用 unzip 命令仅提取 assets/ 目录
  console.log(`提取 assets/ 从 ${jarPath}...`);
  await mkdir(assetsOutput, { recursive: true });
  await rm(tmpOutput, { recursive: true, force: true });
  await mkdir(tmpOutput, { recursive: true });

  try {
    await execFile('unzip', ['-oq', jarPath, 'assets/minecraft/*', '-d', tmpOutput], { maxBuffer: 50 * 1024 * 1024 });
  } catch (e: any) {
    throw new Error(`unzip 失败: ${e.message?.slice(0, 300) ?? e}`);
  }

  const srcDir = join(tmpOutput, 'assets', 'minecraft');
  if (!existsSync(srcDir)) throw new Error(`jar 中没有 assets/minecraft: ${jarPath}`);
  await rm(join(assetsOutput, 'minecraft'), { recursive: true, force: true });
  await copy(srcDir, join(assetsOutput, 'minecraft'), { recursive: true, force: true });
  await rm(tmpOutput, { recursive: true, force: true });

  console.log(`\n✅ 资源已提取到: ${assetsOutput}`);
  console.log(`   结构: ${assetsOutput}/minecraft/{blockstates,models,textures}`);
  console.log(`   可设置环境变量: ASSETS_DIRS=${assetsOutput}`);
}

async function extractAllAssets(minVersion: string, outputDir: string, includeSnapshots: boolean, dryRun = false) {
  const manifest = await getManifest();
  const versions = manifest.versions.filter((v) => {
    if (!includeSnapshots && v.type !== 'release') return false;
    // 简单版本比较（major.minor.patch）
    return compareVersions(v.id, minVersion) >= 0;
  });

  console.log(`将提取 ${versions.length} 个版本 (>= ${minVersion})`);
  for (const v of versions) {
    console.log(`\n--- ${v.id} ---`);
    try {
      await extractAssets(v.id, join(outputDir, `minecraft-${v.id}`), dryRun);
    } catch (e) {
      console.error(`  失败: ${(e as Error).message}`);
    }
  }
  console.log('\n✅ 全部完成');
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
  console.log(`✅ biomes.json 已生成: ${outputFile} (${Object.keys(biomeMap).length} 个群系)`);
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
  console.log(`✅ dimensions.json 已生成: ${outputFile}`);
}

async function importMinecraftData(versionId: string): Promise<any> {
  try {
    const mcDataModule = await import('minecraft-data');
    return mcDataModule.default(versionId);
  } catch {
    console.error(`minecraft-data 不支持版本 ${versionId}，请尝试较新版本。`);
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
    console.log(`Violet Map 资源提取工具

用法:
  pnpm vm-assets list-versions
    列出所有可用的 release 版本。

  pnpm vm-assets extract [--version <id>] [--dir <dir>] [--dry-run]
    从 Mojang 官方源下载指定版本的 client.jar 并提取资源文件。
    --version: MC 版本号（默认: 1.21.4）
    --dir:     输出目录（默认: ./assets；--output 也可用）

  pnpm vm-assets extract-all [--min-version <id>] [--dir <dir>] [--include-snapshots] [--dry-run]
    提取所有 >= 指定版本号的 release 版本资源。
    --min-version: 最低版本号（默认: 1.18）

  pnpm vm-assets generate-biomes [--version <id>] [--output <file>]
    使用 minecraft-data 生成 biomes.json（群系颜色数据）。
    --output: 输出文件（默认: ./biomes.json）

  pnpm vm-assets generate-dimensions [--version <id>] [--output <file>]
    生成 dimensions.json（维度定义文件）。
    --output: 输出文件（默认: ./dimensions.json）

示例:
  # 提取 1.21.4 的资源到 server 的 assets 目录
  pnpm vm-assets extract --version 1.21.4 --dir ../server/data/assets

  # 生成群系数据
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
      console.error(`未知命令: ${command}。使用 --help 查看帮助。`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('错误:', e.message);
  process.exit(1);
});
