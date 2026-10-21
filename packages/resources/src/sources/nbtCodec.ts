import { detectNbtCompression } from '@violet-map/core/nbt';
import { ResourceError } from '@violet-map/core/resources';
import type { RegionChunkRecord } from '@violet-map/core/region';
import { promisify } from 'node:util';
import { gunzip, inflate } from 'node:zlib';

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

async function decode(data: Uint8Array, compression: 'gzip' | 'zlib'): Promise<Uint8Array> {
  let result: Uint8Array;
  try {
    result = await (compression === 'gzip'
      ? gunzipAsync(data, { maxOutputLength: 16 * 1024 ** 2 })
      : inflateAsync(data, { maxOutputLength: 16 * 1024 ** 2 }));
  } catch (error) {
    throw new ResourceError(
      'RESOURCE_INTEGRITY_FAILED',
      `invalid compressed NBT: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // zlib outputs may retain a larger pooled backing buffer. Keep exactly the
  // decoded bytes so long-lived cache weights also reflect retained memory.
  return new Uint8Array(result);
}

/** Decode an NBT wrapper on Node's worker pool; raw bytes are returned unchanged. */
export function decompressNbt(data: Uint8Array): Promise<Uint8Array> {
  const compression = detectNbtCompression(data);
  return compression ? decode(data, compression) : Promise.resolve(data);
}

/** Return owned decoded NBT using the same Anvil validation as the browser codec. */
export async function decodeRegionChunk(record: RegionChunkRecord): Promise<Uint8Array> {
  if (record.compression === 3) return record.payload.slice();
  return decode(record.payload, record.compression === 1 ? 'gzip' : 'zlib');
}
