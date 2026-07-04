import pako from 'pako';

/** 从 .mca 文件字节中提取一个区块的原始 NBT（已解压）。找不到返回 null。 */
export function getRegionChunk(region: Uint8Array, localX: number, localZ: number): Uint8Array | null {
  if (region.length < 8192) return null;
  const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
  const idx = (localX & 31) + ((localZ & 31) << 5);
  const loc = view.getUint32(idx * 4);
  const sectorOffset = loc >>> 8;
  const sectorCount = loc & 0xff;
  if (sectorOffset === 0 || sectorCount === 0) return null;
  const base = sectorOffset * 4096;
  if (base + 5 > region.length) return null;
  const length = view.getUint32(base);
  const compression = view.getUint8(base + 4);
  const payload = region.subarray(base + 5, base + 4 + length);
  switch (compression) {
    case 1: return pako.ungzip(payload);
    case 2: return pako.inflate(payload);
    case 3: return payload.slice();
    default: throw new Error(`Unknown region compression type ${compression}`);
  }
}

export function* iterateRegionChunks(region: Uint8Array): Generator<{ localX: number; localZ: number; data: Uint8Array }> {
  for (let z = 0; z < 32; z++) {
    for (let x = 0; x < 32; x++) {
      const data = getRegionChunk(region, x, z);
      if (data) yield { localX: x, localZ: z, data };
    }
  }
}