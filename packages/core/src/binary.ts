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
