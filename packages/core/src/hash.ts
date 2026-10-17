const OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Seedable unsigned 32-bit FNV-style hash over UTF-16 code units. Suitable for
 * cache keys and deterministic colors; it is not a cryptographic digest. */
export function hashString32(value: string, seed = OFFSET_BASIS): number {
  let hash = seed;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/** Seedable unsigned FNV-1a over bytes, sharing the string hash's accumulator. */
export function hashBytes32(bytes: Uint8Array, seed = OFFSET_BASIS): number {
  let hash = seed;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}
