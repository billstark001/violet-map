import { ChunkColumn } from './world.js';

export interface LightBlockInfo { filter: number; emit: number }

/**
 * 单列烘焙光照（天光 + 方块光 BFS）。存档缺失光照数据时的回退方案。
 * 注：不跨区块传播，区块边界处洞穴内可能出现轻微接缝。
 */
export function computeColumnLight(
  col: ChunkColumn,
  infoOf: (name: string) => LightBlockInfo,
  hasSkyLight: boolean,
): void {
  const H = col.maxY - col.minY;
  if (H <= 0) return;
  const size = 256 * H;
  const filter = new Uint8Array(size);
  const sky = new Uint8Array(size);
  const block = new Uint8Array(size);
  const emitters: number[] = [];

  const idxOf = (x: number, y: number, z: number) => ((y * 16 + z) * 16 + x);

  // 预填每格的透光衰减和光源
  for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
    const s = col.sections.get(sy);
    if (!s || s.isEmpty) continue;
    const infos = s.palette.map((p) => infoOf(p.name));
    for (let ly = 0; ly < 16; ly++) {
      const y = sy * 16 + ly - col.minY;
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const pi = s.states ? s.states.get((ly << 8) | (lz << 4) | lx) : 0;
          const info = infos[pi];
          if (!info) continue;
          const i = idxOf(lx, y, lz);
          filter[i] = info.filter;
          if (info.emit > 0) { block[i] = info.emit; emitters.push(i); }
        }
      }
    }
  }

  const queue: number[] = [];
  const push = (i: number) => queue.push(i);

  const propagate = (arr: Uint8Array, isSky: boolean) => {
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const level = arr[i];
      if (level <= 1 && !isSky) continue;
      const x = i & 15, z = (i >> 4) & 15, y = i >> 8;
      // 六方向
      for (let d = 0; d < 6; d++) {
        let nx = x, ny = y, nz = z;
        if (d === 0) ny--; else if (d === 1) ny++;
        else if (d === 2) nz--; else if (d === 3) nz++;
        else if (d === 4) nx--; else nx++;
        if (nx < 0 || nx > 15 || nz < 0 || nz > 15 || ny < 0 || ny >= H) continue;
        const ni = idxOf(nx, ny, nz);
        const f = filter[ni];
        let nl: number;
        if (isSky && d === 0 && level === 15 && f === 0) nl = 15;
        else nl = level - Math.max(1, f);
        if (nl > arr[ni]) { arr[ni] = nl; push(ni); }
      }
    }
    queue.length = 0;
  };

  if (hasSkyLight) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = H - 1; y >= 0; y--) {
          const i = idxOf(x, y, z);
          if (filter[i] > 0) break;
          sky[i] = 15;
          push(i);
        }
      }
    }
    propagate(sky, true);
  }

  for (const i of emitters) push(i);
  propagate(block, false);

  // 写回各 section（缺失的补空气 section）
  for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
    const s = col.ensureSection(sy);
    const bl = new Uint8Array(4096);
    const sl = new Uint8Array(4096);
    for (let ly = 0; ly < 16; ly++) {
      const y = sy * 16 + ly - col.minY;
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const src = idxOf(lx, y, lz);
          const dst = (ly << 8) | (lz << 4) | lx;
          bl[dst] = block[src];
          sl[dst] = sky[src];
        }
      }
    }
    s.blockLight = bl;
    s.skyLight = sl;
  }
}