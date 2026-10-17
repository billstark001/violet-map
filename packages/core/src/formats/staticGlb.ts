import { ContentValidationError } from '../contentValidation.js';

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const HEADER_BYTES = 20;
const EXTENSION_FIELDS = new Set(['extensions', 'extensionsUsed', 'extensionsRequired']);
const EMBEDDED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ContentValidationError('GLB requires JSON objects');
  return value as Record<string, unknown>;
}

function entries(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ContentValidationError('GLB requires JSON arrays');
  return value.map(object);
}

function unsupported(message: string): never {
  throw new ContentValidationError(message, 'UNSUPPORTED_FORMAT');
}

/**
 * Parse a GLB 2.0 JSON chunk and enforce overlay schema 1's static, embedded-only
 * subset. Honors byte-view offsets and does not retain or copy binary payloads.
 * This is a support-policy guard, not full glTF schema/accessor validation;
 * importers must also validate the model before publishing it.
 */
export function parseStaticGlb(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < HEADER_BYTES ||
    view.getUint32(0, true) !== GLB_MAGIC ||
    view.getUint32(4, true) !== GLB_VERSION ||
    view.getUint32(8, true) !== bytes.length ||
    view.getUint32(16, true) !== JSON_CHUNK ||
    HEADER_BYTES + view.getUint32(12, true) > bytes.length
  )
    throw new ContentValidationError('invalid GLB 2.0 container');
  let raw: unknown;
  try {
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(HEADER_BYTES, HEADER_BYTES + view.getUint32(12, true)),
      ),
    );
  } catch {
    throw new ContentValidationError('invalid GLB JSON');
  }
  const model = object(raw);
  // Iteration avoids exhausting the JS call stack on deeply nested extras.
  const pending: unknown[] = [model];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (EXTENSION_FIELDS.has(key) && child && Object.keys(child).length)
        unsupported('GLB extensions, including compression, are unsupported in schema 1');
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  if (
    entries(model.animations).length ||
    entries(model.skins).length ||
    entries(model.nodes).some((node) => node.skin !== undefined) ||
    entries(model.meshes).some((mesh) => entries(mesh.primitives).some((p) => entries(p.targets).length))
  )
    unsupported('GLB must be static without animation, skins or morph targets');
  if (
    entries(model.buffers).some((buffer) => buffer.uri !== undefined) ||
    entries(model.images).some(
      (image) =>
        image.uri !== undefined || image.bufferView === undefined || !EMBEDDED_IMAGE_TYPES.has(String(image.mimeType)),
    )
  )
    unsupported('GLB dependencies must be embedded PNG/JPEG buffer views');
  return raw;
}
