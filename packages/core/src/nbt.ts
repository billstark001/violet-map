import { Buffer } from 'buffer';
import pako from 'pako';
import * as nbt from 'prismarine-nbt';

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

/** prismarine-nbt 的 longArray 可能是 [hi,lo] 对、BigInt 数组或 TypedArray。统一为 BigUint64Array。 */
export function toLongs(value: unknown): BigUint64Array {
  if (value instanceof BigUint64Array) return value;
  if (value instanceof BigInt64Array) return new BigUint64Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  const arr = value as Array<[number, number] | bigint>;
  const out = new BigUint64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    out[i] = typeof v === 'bigint'
      ? BigInt.asUintN(64, v)
      : (BigInt(v[0] >>> 0) << 32n) | BigInt(v[1] >>> 0);
  }
  return out;
}

export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const arr = value as ArrayLike<number>;
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] & 0xff;
  return out;
}