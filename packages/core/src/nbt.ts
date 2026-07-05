import { Buffer } from 'buffer';
import * as pako from 'pako';
import * as nbt from 'prismarine-nbt';
export { toLongs, toBytes } from './binary.js';

/** 自动识别 gzip / zlib / 未压缩。 */
export function decompress(data: Uint8Array): Uint8Array {
  if (data.length > 1 && data[0] === 0x1f && data[1] === 0x8b) return pako.ungzip(data);
  if (data.length > 0 && data[0] === 0x78) return pako.inflate(data);
  return data;
}

/** 解析 NBT 为 simplify 后的普通 JS 对象。 */
export function parseNbt(data: Uint8Array): any {
  const raw = decompress(data);
  const parsed = nbt.parseUncompressed(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  return nbt.simplify(parsed);
}
