import { ChunkColumn } from './world.js';

export interface LightBlockInfo {
  filter: number;
  emit: number;
}
export interface ComputeLightOptions {
  writeSky?: boolean;
  writeBlock?: boolean;
}

function lightLevel(value: number): number {
  return Number.isFinite(value) ? Math.min(15, Math.max(0, Math.floor(value))) : 0;
}

/**
 * Recompute missing sky and/or block light in a single chunk column.
 * Each selected channel overwrites section light arrays in place. This is a
 * fallback for missing saved light; propagation stops at chunk boundaries,
 * so enclosed spaces can show minor seams between columns.
 */
export function computeColumnLight(
  col: ChunkColumn,
  infoOf: (name: string) => LightBlockInfo,
  hasSkyLight: boolean,
  opts: ComputeLightOptions = {},
): void {
  const H = col.maxY - col.minY;
  if (H <= 0) return;
  const writeSky = opts.writeSky ?? true;
  const writeBlock = opts.writeBlock ?? true;
  const bakeSky = writeSky && hasSkyLight;
  if (!bakeSky && !writeBlock) return;
  const size = 256 * H;
  const filter = new Uint8Array(size);
  const sky = bakeSky ? new Uint8Array(size) : null;
  const block = writeBlock ? new Uint8Array(size) : null;
  const emitters: number[] = [];

  const idxOf = (x: number, y: number, z: number) => (y * 16 + z) * 16 + x;

  // 预填每格的透光衰减和光源
  for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
    const s = col.sections.get(sy);
    if (!s || s.isEmpty) continue;
    const infos = s.palette.map((p) => infoOf(p.name));
    const filters = Uint8Array.from(infos, (info) => lightLevel(info.filter));
    const emissions = block ? Uint8Array.from(infos, (info) => lightLevel(info.emit)) : null;
    for (let ly = 0; ly < 16; ly++) {
      const y = sy * 16 + ly - col.minY;
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const pi = s.blockIndex(lx, ly, lz);
          if (pi >= infos.length) continue;
          const i = idxOf(lx, y, lz);
          filter[i] = filters[pi];
          if (block && emissions && emissions[pi] > 0) {
            block[i] = emissions[pi];
            emitters.push(i);
          }
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
      const x = i & 15,
        z = (i >> 4) & 15,
        y = i >> 8;
      // 六方向
      for (let d = 0; d < 6; d++) {
        let nx = x,
          ny = y,
          nz = z;
        if (d === 0) ny--;
        else if (d === 1) ny++;
        else if (d === 2) nz--;
        else if (d === 3) nz++;
        else if (d === 4) nx--;
        else nx++;
        if (nx < 0 || nx > 15 || nz < 0 || nz > 15 || ny < 0 || ny >= H) continue;
        const ni = idxOf(nx, ny, nz);
        const f = filter[ni];
        let nl: number;
        if (isSky && d === 0 && level === 15 && f === 0) nl = 15;
        else nl = level - Math.max(1, f);
        if (nl > arr[ni]) {
          arr[ni] = nl;
          push(ni);
        }
      }
    }
    queue.length = 0;
  };

  if (sky) {
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

  if (block) {
    for (const i of emitters) push(i);
    propagate(block, false);
  }

  // 写回各 section（缺失的补空气 section）
  for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
    const s = col.ensureSection(sy);
    const bl = block ? new Uint8Array(4096) : null;
    const sl = sky ? new Uint8Array(4096) : null;
    for (let ly = 0; ly < 16; ly++) {
      const y = sy * 16 + ly - col.minY;
      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const src = idxOf(lx, y, lz);
          const dst = (ly << 8) | (lz << 4) | lx;
          if (bl && block) bl[dst] = block[src];
          if (sl && sky) sl[dst] = sky[src];
        }
      }
    }
    if (bl) s.blockLight = bl;
    if (sl) s.skyLight = sl;
  }
  if (writeBlock) col.hasStoredBlockLight = true;
  if (bakeSky) col.hasStoredSkyLight = true;
  col.hasStoredLight = true;
}
