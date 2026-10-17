/** Minimal static alpha-blended GLB, decoded by the real lazy GLTFLoader. */
export function transparencyGlb(): ArrayBuffer {
  const positions = new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, -2, 0, 2, 2, 0, -2, 2, 0]);
  const raw = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        {
          alphaMode: 'BLEND',
          doubleSided: true,
          pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 0.5], metallicFactor: 0, roughnessFactor: 1 },
        },
      ],
      buffers: [{ byteLength: positions.byteLength }],
      bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3', min: [-2, -2, 0], max: [2, 2, 0] }],
    }),
  );
  const jsonLength = Math.ceil(raw.length / 4) * 4;
  const buffer = new ArrayBuffer(28 + jsonLength + positions.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, buffer.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, jsonLength).fill(0x20);
  new Uint8Array(buffer, 20, raw.length).set(raw);
  view.setUint32(20 + jsonLength, positions.byteLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  new Uint8Array(buffer, 28 + jsonLength).set(new Uint8Array(positions.buffer));
  return buffer;
}
