import { ChunkColumn, AIR_NAMES } from './world.js';
import { BlockStateRef, MeshBuffers } from './types.js';
import type { Rgb } from './colors.js';
import { Float32Writer, Uint32Writer } from './meshBufferBuilder.js';

interface LodCell {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  height: number;
  color: Rgb;
}

class LodBuilder {
  pos = new Float32Writer(1024 * 3);
  uv = new Float32Writer(1024 * 2);
  col = new Float32Writer(1024 * 3);
  light = new Float32Writer(1024 * 2);
  idx = new Uint32Writer(1024 * 6);
  verts = 0;

  vertex(x: number, y: number, z: number, color: Rgb, light: [number, number], shade: number) {
    this.pos.push3(x, y, z);
    this.uv.push2(0, 0);
    this.col.push3(color[0] * shade, color[1] * shade, color[2] * shade);
    this.light.push2(light[0], light[1]);
    this.verts++;
  }

  quad(verts: [number, number, number][], color: Rgb, light: [number, number], shade: number) {
    for (const v of verts) this.vertex(v[0], v[1], v[2], color, light, shade);
    const b = this.verts - 4;
    this.idx.push6(b, b + 2, b + 1, b, b + 3, b + 2);
  }

  build(): MeshBuffers {
    return {
      positions: this.pos.toArray(),
      uvs: this.uv.toArray(),
      colors: this.col.toArray(),
      lights: this.light.toArray(),
      indices: this.idx.toArray(),
    };
  }
}

function sampleCell(
  col: ChunkColumn,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  colorOf: (state: BlockStateRef, biome: string) => Rgb,
): LodCell | null {
  let height = col.minY;
  let r = 0, g = 0, b = 0, n = 0;
  for (let z = z0; z < z1; z++) {
    for (let x = x0; x < x1; x++) {
      const h = col.heightAt(x, z);
      if (h <= col.minY) continue;
      height = Math.max(height, h);
      let top = col.getBlock(x, h - 1, z);
      if (AIR_NAMES.has(top.name)) top = col.getBlock(x, Math.max(h - 2, col.minY), z);
      const c = colorOf(top, col.getBiome(x, h, z));
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
  }
  if (!n) return null;
  return { x0, x1, z0, z1, height, color: [r / n, g / n, b / n] };
}

/**
 * 低 LOD：按 step 采样为多个柱状长方体面片。
 * y 为绝对坐标，x/z 相对区块原点。
 */
export function meshLodChunk(
  col: ChunkColumn,
  step: number,
  colorOf: (state: BlockStateRef, biome: string) => Rgb,
  hasSkyLight = true,
): MeshBuffers | null {
  const s = Math.max(1, Math.floor(step));
  const n = Math.ceil(16 / s);
  const cells: (LodCell | null)[] = [];
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const x0 = gx * s;
      const z0 = gz * s;
      cells.push(sampleCell(col, x0, z0, Math.min(x0 + s, 16), Math.min(z0 + s, 16), colorOf));
    }
  }
  if (!cells.some(Boolean)) return null;

  const builder = new LodBuilder();
  const baseY = col.minY;
  const light: [number, number] = hasSkyLight ? [1, 0] : [0, 1];
  const at = (gx: number, gz: number) => (gx < 0 || gx >= n || gz < 0 || gz >= n) ? null : cells[gx + gz * n];
  const neighborHeight = (gx: number, gz: number): number | null => {
    if (gx < 0 || gx >= n || gz < 0 || gz >= n) return null;
    return at(gx, gz)?.height ?? null;
  };

  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const c = at(gx, gz);
      if (!c || c.height <= baseY) continue;
      const { x0, x1, z0, z1, height: h, color } = c;

      builder.quad([[x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]], color, light, 1);

      const north = neighborHeight(gx, gz - 1);
      if (north !== null && h > north) builder.quad([[x1, h, z0], [x0, h, z0], [x0, north, z0], [x1, north, z0]], color, light, 0.8);

      const south = neighborHeight(gx, gz + 1);
      if (south !== null && h > south) builder.quad([[x0, h, z1], [x1, h, z1], [x1, south, z1], [x0, south, z1]], color, light, 0.8);

      const west = neighborHeight(gx - 1, gz);
      if (west !== null && h > west) builder.quad([[x0, h, z0], [x0, h, z1], [x0, west, z1], [x0, west, z0]], color, light, 0.6);

      const east = neighborHeight(gx + 1, gz);
      if (east !== null && h > east) builder.quad([[x1, h, z1], [x1, h, z0], [x1, east, z0], [x1, east, z1]], color, light, 0.6);
    }
  }

  return builder.build();
}
