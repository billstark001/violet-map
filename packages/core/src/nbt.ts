import { Buffer } from 'buffer';
import * as pako from 'pako';
import * as nbt from 'prismarine-nbt';

export { toLongs, toBytes } from './binary.js';

/** Detect an RFC 1950 DEFLATE header without assuming a 32 KiB window. */
function hasZlibHeader(data: Uint8Array): boolean {
  if (data.length < 2) return false;
  const cmf = data[0];
  const flg = data[1];
  return (cmf & 0x0f) === 8 && cmf >> 4 <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

/** Identify a supported NBT wrapper without decoding or validating its payload. */
export function detectNbtCompression(data: Uint8Array): 'gzip' | 'zlib' | null {
  if (data.length > 1 && data[0] === 0x1f && data[1] === 0x8b) return 'gzip';
  return hasZlibHeader(data) ? 'zlib' : null;
}

/** Decode gzip or zlib wrapped NBT, leaving raw NBT unchanged. */
export function decompress(data: Uint8Array): Uint8Array {
  const compression = detectNbtCompression(data);
  if (compression === 'gzip') return pako.ungzip(data);
  if (compression === 'zlib') return pako.inflate(data);
  return data;
}

/** 解析 NBT 为 simplify 后的普通 JS 对象。 */
export function parseNbt(data: Uint8Array): any {
  const raw = decompress(data);
  const parsed = nbt.parseUncompressed(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
  return nbt.simplify(parsed);
}
