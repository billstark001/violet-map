import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { inspectMedia } from '../src/mediaInspection.js';

const svg = (body: string) =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8">${body}</svg>`);

export function triangleGlb(changes: Record<string, unknown> = {}) {
  const binary = Buffer.alloc(36);
  new Float32Array(binary.buffer, binary.byteOffset, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, translation: [1, 2, 3] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: 36 }],
      bufferViews: [{ buffer: 0, byteLength: 36, target: 34962 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      ...changes,
    }),
  );
  const aligned = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(aligned);
  const out = Buffer.alloc(28 + aligned.length + binary.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(aligned.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  aligned.copy(out, 20);
  out.writeUInt32LE(binary.length, 20 + aligned.length);
  out.writeUInt32LE(0x004e4942, 24 + aligned.length);
  binary.copy(out, 28 + aligned.length);
  return out;
}

test('media inspection accepts three bitmap formats, static SVG and GLB; rejects incomplete or active input', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const bytes = await sharp({
      create: { width: 4, height: 2, channels: 4, background: { r: 128, g: 0, b: 255, alpha: 0.5 } },
    })
      .toFormat(format)
      .toBuffer();
    const version = await inspectMedia('asset', bytes, `image/${format}`);
    assert.equal(version.width, 4);
    assert.equal(version.height, 2);
    assert.equal(version.versionId.length, 64);
  }
  assert.equal((await inspectMedia('asset', svg('<path d="M0 0h16v8H0z"/>'), 'image/svg+xml')).width, 16);
  for (const body of [
    '<script>alert(1)</script>',
    '<text>convert to paths</text>',
    '<image href="https://bad.example/x"/>',
    '<use href="file:///etc/passwd"/>',
    '<path style="fill:red"/>',
    '<foreignObject/>',
    '<path onload="alert(1)"/>',
  ])
    await assert.rejects(inspectMedia('asset', svg(body), 'image/svg+xml'));
  await assert.rejects(inspectMedia('asset', new Uint8Array([1, 2, 3]), 'image/png'));
  const model = await inspectMedia('asset', triangleGlb(), 'model/gltf-binary');
  assert.deepEqual(model.bounds, { min: [1, 2, 3], max: [2, 3, 3] });
  for (const changes of [
    { extensionsUsed: ['KHR_draco_mesh_compression'] },
    { buffers: [{ uri: 'external.bin', byteLength: 36 }] },
    { animations: [{}] },
    { meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{}] }] }] },
  ])
    await assert.rejects(inspectMedia('asset', triangleGlb(changes), 'model/gltf-binary'));
});
