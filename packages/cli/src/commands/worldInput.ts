import fs from 'node:fs/promises';
import path from 'node:path';
import { ChunkColumn, parseChunkColumn } from '@violet-map/core/domain';
import { parseNbt } from '@violet-map/core/nbt';
import { iterateRegionChunks } from '@violet-map/core/region';
import { isMissingPath, resolvePath } from './paths.js';

export interface ColumnEntry {
  col: ChunkColumn;
  litSky: boolean;
  litBlock: boolean;
}

export interface RegionFile {
  rx: number;
  rz: number;
  file: string;
}

export const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

export async function loadRegionColumns(file: string, sourceBytes?: Uint8Array): Promise<Map<string, ColumnEntry>> {
  const bytes = sourceBytes ?? new Uint8Array(await fs.readFile(resolvePath(file)));
  const entries = new Map<string, ColumnEntry>();
  for (const chunk of iterateRegionChunks(bytes)) {
    const col = parseChunkColumn(parseNbt(chunk.data));
    entries.set(`${col.x},${col.z}`, {
      col,
      litSky: col.hasStoredSkyLight,
      litBlock: col.hasStoredBlockLight,
    });
  }
  return entries;
}

export async function findRegionFiles(worldDir: string, dim: string): Promise<RegionFile[]> {
  const world = resolvePath(worldDir);
  const candidates = dimensionRegionDirs(world, dim);
  const out: RegionFile[] = [];
  for (const dir of candidates) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = REGION_RE.exec(entry.name);
      if (!match) continue;
      out.push({ rx: Number(match[1]), rz: Number(match[2]), file: path.join(dir, entry.name) });
    }
  }
  return out.sort((a, b) => a.rx - b.rx || a.rz - b.rz);
}

export function dimensionRegionDirs(world: string, dim: string): string[] {
  if (dim === 'minecraft:overworld')
    return [path.join(world, 'region'), path.join(world, 'dimensions/minecraft/overworld/region')];
  if (dim === 'minecraft:the_nether')
    return [path.join(world, 'DIM-1/region'), path.join(world, 'dimensions/minecraft/the_nether/region')];
  if (dim === 'minecraft:the_end')
    return [path.join(world, 'DIM1/region'), path.join(world, 'dimensions/minecraft/the_end/region')];
  const [namespace, rawPath = ''] = dim.includes(':') ? dim.split(':') : ['minecraft', dim];
  return [path.join(world, 'dimensions', namespace, rawPath, 'region')];
}

export function defaultTopMapOut(worldDir: string): string {
  return path.join(resolvePath(worldDir), '.violet-map/top-map');
}
