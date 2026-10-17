import type { MeshBuffers } from './types.js';

/**
 * Encoded attribute bytes approximate GPU upload size. Retained bytes count
 * complete backing allocations, once per mesh, including unused writer capacity.
 * Use retained accounting for CPU caches and structured-clone queues.
 */
export function meshByteLength(mesh: MeshBuffers, mode: 'encoded' | 'retained' = 'encoded'): number {
  if (mode === 'encoded')
    return (
      mesh.positions.byteLength +
      (mesh.uvs?.byteLength ?? 0) +
      (mesh.atlasRects?.byteLength ?? 0) +
      mesh.colors.byteLength +
      mesh.lights.byteLength +
      (mesh.animations?.byteLength ?? 0) +
      mesh.indices.byteLength
    );
  const seen = new Set<ArrayBufferLike>();
  let bytes = 0;
  for (const attribute of [
    mesh.positions,
    mesh.uvs,
    mesh.atlasRects,
    mesh.colors,
    mesh.lights,
    mesh.animations,
    mesh.indices,
  ]) {
    if (!attribute || seen.has(attribute.buffer)) continue;
    seen.add(attribute.buffer);
    bytes += attribute.buffer.byteLength;
  }
  return bytes;
}
