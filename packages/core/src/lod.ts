import { ChunkColumn, AIR_NAMES } from './world.js';
import { MeshBuffers } from './types.js';
import type { Rgb } from './colors.js';

/**
 * 低 LOD：基于高度图的连续高度场网格（(16/step+1)² 顶点），逐顶点颜色。
 * y 为绝对坐标，x/z 相对区块原点。
 */
export function meshLodChunk(
  col: ChunkColumn,
  step: number,
  colorOf: (blockName: string, biome: string) => Rgb,
): MeshBuffers | null {
  const n = Math.max(1, Math.floor(16 / step));
  const verts = (n + 1) * (n + 1);
  const positions = new Float32Array(verts * 3);
  const colors = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const lights = new Float32Array(verts * 2);
  let hasAny = false;

  for (let gz = 0; gz <= n; gz++) {
    for (let gx = 0; gx <= n; gx++) {
      const x = Math.min(gx * step, 15);
      const z = Math.min(gz * step, 15);
      const h = col.heightAt(x, z);
      if (h > col.minY) hasAny = true;
      let top = col.getBlock(x, h - 1, z);
      if (AIR_NAMES.has(top.name)) top = col.getBlock(x, Math.max(h - 2, col.minY), z);
      const c = colorOf(top.name, col.getBiome(x, h, z));
      const i = gz * (n + 1) + gx;
      positions[i * 3] = gx * step;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = gz * step;
      colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
      lights[i * 2] = 1; lights[i * 2 + 1] = 0;
    }
  }
  if (!hasAny) return null;

  const indices = new Uint32Array(n * n * 6);
  let p = 0;
  for (let gz = 0; gz < n; gz++) {
    for (let gx = 0; gx < n; gx++) {
      const a = gz * (n + 1) + gx, b = a + 1, c = a + n + 1, d = c + 1;
      indices[p++] = a; indices[p++] = c; indices[p++] = d;
      indices[p++] = a; indices[p++] = d; indices[p++] = b;
    }
  }
  return { positions, uvs, colors, lights, indices };
}