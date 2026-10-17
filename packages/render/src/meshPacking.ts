export function packNormalizedUint8(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, values[i])) * 255);
  return out;
}

export function packNormalizedUint16(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, values[i])) * 65535);
  return out;
}

/** Pack valid zero-based indices; 65536 vertices still fit in an unsigned short. */
export function packIndices(values: Uint32Array, vertexCount: number): Uint16Array | Uint32Array {
  if (vertexCount > 65536) return values;
  return new Uint16Array(values);
}

export function boundsOfPositions(values: Float32Array): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += 3) {
    min[0] = Math.min(min[0], values[i]);
    min[1] = Math.min(min[1], values[i + 1]);
    min[2] = Math.min(min[2], values[i + 2]);
    max[0] = Math.max(max[0], values[i]);
    max[1] = Math.max(max[1], values[i + 1]);
    max[2] = Math.max(max[2], values[i + 2]);
  }
  return { min, max };
}
