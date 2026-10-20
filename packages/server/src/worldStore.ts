import { mapWithConcurrency } from '@violet-map/core/async';
import type { WorldFileManifestEntry, WorldInfo } from '@violet-map/core/contracts';
import { assertDimensionId, assertWorldName, isChunkCoordinate } from '@violet-map/core/domain';
import { parseNbt } from '@violet-map/core/nbt';
import { parseRegionFileName } from '@violet-map/core/region';
import type { ObjectStorage } from '@violet-map/core/storage';
import { decompressNbt } from '@violet-map/resources/nbt-codec';
import { createWorldSource } from '@violet-map/resources/world-chunks';
import { cleanStoragePath, ensureWorldIdentity, ScopedStorage } from '@violet-map/storage';
import type { ServerConfig } from './configuration.js';
import { createMinimalLevelDat } from './levelDat.js';
import { isWorldDiffInput } from './worldValidation.js';

export function createWorldStore(worldStorage: ObjectStorage, config: ServerConfig) {
  const source = createWorldSource(worldStorage, config);
  const {
    cacheStats,
    listWorlds,
    listRegions,
    listChunkSourceCoverage,
    getChunkMetadataBatch,
    getChunkMetadata,
    getChunksNbtWithMetaBatch,
    getChunkNbtWithMeta,
    invalidateWorldList,
    invalidateStoredFile,
    invalidatePath,
    clearChunkCacheFor,
    clearWorldDirectoryCaches,
    clearWorldObjectCaches,
    regionDir,
    chunkOverrideDir,
    regionPathFromDir,
    readRegionFile,
    hasRegionChunk,
    hashFileInfo,
    readJson,
  } = source;
  interface WorldMeta {
    id: string;
    dimensions: string[];
    createdAt: string;
    updatedAt: string;
  }
  const DEFAULT_DIMS = ['minecraft:overworld'];
  const MAX_PARALLEL_HASH_READS = 4;
  const levelDatPath = (world: string) => world + '/level.dat';
  const worldMetaPath = (world: string) => world + '/.violet-map/world.json';
  function clearRegionChunkEntries(region: Uint8Array, locals: { localX: number; localZ: number }[]): Uint8Array {
    const out = region.slice();
    for (const { localX, localZ } of locals) {
      const idx = (localX & 31) + ((localZ & 31) << 5);
      out.fill(0, idx * 4, idx * 4 + 4);
      out.fill(0, 4096 + idx * 4, 4096 + idx * 4 + 4);
    }
    return out;
  }
  async function writeJson(filePath: string, value: unknown): Promise<void> {
    await worldStorage.write(
      filePath,
      new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`),
      'application/json',
    );
    invalidatePath(filePath);
  }
  async function writeWorldMeta(world: string, dimensions = DEFAULT_DIMS): Promise<void> {
    for (const dim of dimensions) assertDimensionId(dim);
    const now = new Date().toISOString();
    const previous = await readJson<WorldMeta>(worldMetaPath(world));
    const unique = [...new Set([...(previous?.dimensions ?? []), ...dimensions])];
    await writeJson(worldMetaPath(world), {
      id: world,
      dimensions: unique.length ? unique : DEFAULT_DIMS,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    } satisfies WorldMeta);
  }
  async function ensureLevelDat(world: string, levelName = world, dimensions = DEFAULT_DIMS): Promise<void> {
    assertWorldName(world);
    if (typeof levelName !== 'string') throw new Error('invalid level name');
    if (!Array.isArray(dimensions)) throw new Error('invalid dimensions');
    for (const dimension of dimensions) assertDimensionId(dimension);
    if (!(await worldStorage.stat(levelDatPath(world)))) {
      await worldStorage.write(
        levelDatPath(world),
        createMinimalLevelDat({ levelName }, config.minecraft.version),
        'application/octet-stream',
      );
      invalidatePath(levelDatPath(world));
    }
    await writeWorldMeta(world, dimensions);
    await ensureWorldIdentity(new ScopedStorage(worldStorage, world));
    invalidateWorldList();
  }
  async function saveRegionFile(world: string, dim: string, name: string, bytes: Uint8Array): Promise<void> {
    if (!parseRegionFileName(name)) throw new Error('invalid region file name');
    const dir = await regionDir(world, dim);
    const filePath = `${dir}/${name}`;
    await worldStorage.write(filePath, bytes, 'application/octet-stream');
    invalidatePath(filePath);
    clearChunkCacheFor(world, dim);
    await ensureLevelDat(world, world, [dim]);
  }
  async function saveChunkNbt(world: string, dim: string, bytes: Uint8Array): Promise<{ x: number; z: number }> {
    const data = await decompressNbt(bytes);
    const root = parseNbt(data);
    const r = root.Level ?? root;
    const x = r.xPos,
      z = r.zPos;
    if (!isChunkCoordinate(x) || !isChunkCoordinate(z)) throw new Error('chunk NBT has invalid xPos/zPos');
    const filePath = `${chunkOverrideDir(world, dim)}/c.${x}.${z}.nbt`;
    await worldStorage.write(filePath, data, 'application/octet-stream');
    invalidatePath(filePath);
    await ensureLevelDat(world, world, [dim]);
    return { x, z };
  }
  async function createWorld(world: string, dimensions = DEFAULT_DIMS, levelName = world): Promise<WorldInfo> {
    await ensureLevelDat(world, levelName, dimensions);
    return { id: world, dimensions };
  }
  async function deleteWorld(world: string): Promise<{ deleted: number }> {
    assertWorldName(world);
    const deleted = await worldStorage.deletePrefix(world);
    clearChunkCacheFor(world);
    clearWorldDirectoryCaches(world);
    clearWorldObjectCaches(world);
    invalidateWorldList();
    return { deleted };
  }
  async function deleteRegion(world: string, dim: string, rx: number, rz: number): Promise<{ deleted: boolean }> {
    const filePath = regionPathFromDir(await regionDir(world, dim), rx, rz);
    const existed = !!(await worldStorage.stat(filePath));
    await worldStorage.delete(filePath);
    invalidatePath(filePath);
    clearChunkCacheFor(world, dim);
    return { deleted: existed };
  }
  async function deleteChunks(
    world: string,
    dim: string,
    chunks: { cx: number; cz: number }[],
  ): Promise<{ deletedOverrides: number; clearedRegionChunks: number }> {
    assertWorldName(world);
    assertDimensionId(dim);
    if (
      !Array.isArray(chunks) ||
      chunks.some((chunk) => !chunk || !isChunkCoordinate(chunk.cx) || !isChunkCoordinate(chunk.cz))
    )
      throw new Error('invalid chunk coordinates');
    let deletedOverrides = 0;
    let clearedRegionChunks = 0;
    const byRegion = new Map<string, { filePath: string; locals: Map<string, { localX: number; localZ: number }> }>();

    for (const { cx, cz } of chunks) {
      const overridePath = `${chunkOverrideDir(world, dim)}/c.${cx}.${cz}.nbt`;
      if (await worldStorage.stat(overridePath)) {
        await worldStorage.delete(overridePath);
        invalidatePath(overridePath);
        deletedOverrides++;
      }
      const rx = cx >> 5;
      const rz = cz >> 5;
      const filePath = regionPathFromDir(await regionDir(world, dim), rx, rz);
      const key = `${rx},${rz}`;
      const group = byRegion.get(key) ?? { filePath, locals: new Map() };
      group.locals.set(`${cx & 31},${cz & 31}`, { localX: cx & 31, localZ: cz & 31 });
      byRegion.set(key, group);
    }

    for (const { filePath, locals } of byRegion.values()) {
      const region = await readRegionFile(filePath);
      if (!region) continue;
      const present = [...locals.values()].filter((p) => hasRegionChunk(region.bytes, p.localX, p.localZ));
      if (!present.length) continue;
      await worldStorage.write(filePath, clearRegionChunkEntries(region.bytes, present), 'application/octet-stream');
      invalidatePath(filePath);
      clearedRegionChunks += present.length;
    }

    clearChunkCacheFor(world, dim);
    return { deletedOverrides, clearedRegionChunks };
  }
  async function saveWorldFile(
    world: string,
    relativePath: string,
    bytes: Uint8Array,
  ): Promise<WorldFileManifestEntry> {
    assertWorldName(world);
    const cleanRel = cleanStoragePath(relativePath);
    if (!cleanRel) throw new Error('missing file path');
    const fullPath = `${world}/${cleanRel}`;
    await worldStorage.write(fullPath, bytes, 'application/octet-stream');
    invalidateStoredFile(fullPath);
    await ensureLevelDat(world, world);
    const info = await worldStorage.stat(fullPath);
    if (!info) throw new Error('uploaded file is not readable');
    return { ...info, path: cleanRel, hash: await hashFileInfo(info) };
  }
  async function worldManifest(world: string): Promise<WorldFileManifestEntry[]> {
    assertWorldName(world);
    const prefix = `${world}/`;
    const files = await worldStorage.list(prefix);
    return mapWithConcurrency(files, MAX_PARALLEL_HASH_READS, async (file) => ({
      path: file.path.slice(prefix.length),
      size: file.size,
      modifiedAt: file.modifiedAt,
      etag: file.etag,
      hash: await hashFileInfo(file),
    }));
  }
  async function diffWorldManifest(
    world: string,
    files: { path: string; hash?: string; size?: number }[],
  ): Promise<{ upload: string[]; same: string[]; remoteExtra: string[] }> {
    if (!isWorldDiffInput({ files })) throw new Error('invalid world manifest');
    const remote = await worldManifest(world);
    const remoteByPath = new Map(remote.map((f) => [f.path, f]));
    const wanted = new Set<string>();
    const upload: string[] = [];
    const same: string[] = [];
    for (const file of files) {
      const clean = cleanStoragePath(file.path);
      wanted.add(clean);
      const current = remoteByPath.get(clean);
      if (
        !current ||
        (file.hash && file.hash !== current.hash) ||
        (file.size !== undefined && file.size !== current.size)
      ) {
        upload.push(clean);
      } else {
        same.push(clean);
      }
    }
    const remoteExtra = remote.map((f) => f.path).filter((p) => !wanted.has(p));
    return { upload, same, remoteExtra };
  }
  return {
    cacheStats,
    assertWorldName,
    invalidateStoredFile,
    ensureLevelDat,
    listWorlds,
    listRegions,
    listChunkSourceCoverage,
    getChunkMetadataBatch,
    getChunkMetadata,
    getChunksNbtWithMetaBatch,
    getChunkNbtWithMeta,
    saveRegionFile,
    saveChunkNbt,
    createWorld,
    deleteWorld,
    deleteRegion,
    deleteChunks,
    saveWorldFile,
    worldManifest,
    diffWorldManifest,
  };
}

export type WorldStore = ReturnType<typeof createWorldStore>;
