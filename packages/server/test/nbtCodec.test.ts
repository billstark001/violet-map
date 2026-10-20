import { decompress } from '@violet-map/core/nbt';
import { getRegionChunk } from '@violet-map/core/region';
import { decodeRegionChunk, decompressNbt } from '@violet-map/resources/nbt-codec';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync, gzipSync } from 'node:zlib';

const raw = new Uint8Array([10, 0, 0, 0]);

test('native codec agrees with portable NBT decoding and owns exact output buffers', async () => {
  for (const input of [raw, gzipSync(raw), deflateSync(raw, { windowBits: 9 })]) {
    const output = await decompressNbt(input);
    assert.deepEqual(output, decompress(input));
    assert.equal(output.buffer.byteLength, output.byteLength);
  }
  await assert.rejects(decompressNbt(new Uint8Array([0x1f, 0x8b])), /unexpected end/i);
});

test('native Anvil decoder shares validation and returns owned bytes for all formats', async () => {
  for (const [index, payload] of [gzipSync(raw), deflateSync(raw), raw].entries()) {
    // Exercise non-zero input offsets, including an uncompressed borrowed record.
    const backing = new Uint8Array(3 * 4096 + 7);
    const region = backing.subarray(7);
    const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
    view.setUint32(0, (2 << 8) | 1);
    view.setUint32(8192, payload.length + 1);
    region[8196] = index + 1;
    region.set(payload, 8197);
    const output = await decodeRegionChunk(region, 0, 0);
    assert.deepEqual(output, getRegionChunk(region, 0, 0));
    assert.notEqual(output!.buffer, backing.buffer);
    assert.equal(output!.buffer.byteLength, raw.byteLength);
    assert.equal(await decodeRegionChunk(region, 1, 0), null);
    view.setUint32(8192, 4093);
    assert.equal(await decodeRegionChunk(region, 0, 0), null);
    view.setUint32(8192, payload.length + 1);
    region[8196] = 99;
    await assert.rejects(decodeRegionChunk(region, 0, 0), /Unknown region compression type/);
  }
});
