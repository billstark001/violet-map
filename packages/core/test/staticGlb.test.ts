import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContentValidationError, parseStaticGlb } from '../src/overlays.js';

function glb(value: unknown, text = JSON.stringify(value)): Uint8Array {
  const json = new TextEncoder().encode(text);
  const bytes = new Uint8Array(20 + Math.ceil(json.length / 4) * 4).fill(0x20);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, bytes.length - 20, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(json, 20);
  return bytes;
}

test('static GLB policy accepts embedded models and honors byte-view offsets', () => {
  const model = {
    asset: { version: '2.0' },
    images: [{ bufferView: 0, mimeType: 'image/png' }],
    extras: { uri: 'https://credit.example', targets: ['credit'] },
  };
  const bytes = glb(model);
  const padded = new Uint8Array(bytes.length + 7);
  padded.set(bytes, 3);
  assert.deepEqual(parseStaticGlb(padded.subarray(3, 3 + bytes.length)), model);
});

test('static GLB policy rejects unsupported dependencies consistently with content error codes', () => {
  for (const model of [
    { extensionsUsed: ['KHR_draco_mesh_compression'] },
    { extensionsRequired: ['EXT_meshopt_compression'] },
    { materials: [{ extensions: { KHR_materials_unlit: {} } }] },
    { images: [{ uri: 'outside.png' }] },
    { images: [{ bufferView: 0, mimeType: 'image/webp' }] },
    { buffers: [{ uri: 'data:application/octet-stream;base64,AA==' }] },
    { animations: [{}] },
    { skins: [{}] },
    { nodes: [{ skin: 0 }] },
    { meshes: [{ primitives: [{ targets: [{}] }] }] },
  ])
    assert.throws(
      () => parseStaticGlb(glb(model)),
      (error) => error instanceof ContentValidationError && error.code === 'UNSUPPORTED_FORMAT',
    );
});

test('static GLB parsing rejects malformed containers, UTF-8 and collection shapes', () => {
  const valid = glb({});
  const corruptions = [new Uint8Array(), valid.subarray(0, 19), valid.subarray(0, valid.length - 1)];
  for (const offset of [0, 4, 8, 12, 16]) {
    const copy = valid.slice();
    new DataView(copy.buffer).setUint32(offset, 0xffffffff, true);
    corruptions.push(copy);
  }
  const invalidUtf8 = valid.slice();
  invalidUtf8[20] = 0xff;
  corruptions.push(invalidUtf8);
  for (const bytes of corruptions) assert.throws(() => parseStaticGlb(bytes), ContentValidationError);
  for (const model of [null, [], { nodes: {} }, { nodes: [null] }, { meshes: [{ primitives: false }] }])
    assert.throws(() => parseStaticGlb(glb(model)), ContentValidationError);
  assert.throws(() => parseStaticGlb(glb({}, '{bad')), ContentValidationError);
});

test('static GLB extras are traversed without recursive call-stack growth', () => {
  const depth = 20_000;
  const text = '{"extras":' + '{"nested":'.repeat(depth) + '{}' + '}'.repeat(depth) + '}';
  assert.doesNotThrow(() => parseStaticGlb(glb(null, text)));
});
