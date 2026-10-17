/** Read a request or response within a byte budget, cancelling on overflow.
 * Returns owned bytes, or null when the declared/actual body exceeds the budget.
 * Stream failures reject; the reader lock is always released. */
export async function readLimitedBody(
  message: Pick<Request | Response, 'headers' | 'body'>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('invalid body limit');
  const declared = Number(message.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await message.body?.cancel().catch(() => {});
    return null;
  }
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      if (value.byteLength) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Validate an absolute HTTP(S) resource URL without credentials or a fragment. */
export function publicResourceUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || !/^https?:\/\//.test(value))
    throw new TypeError('public resource URL must be absolute HTTP(S)');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new TypeError('public resource URL must not contain credentials or a fragment');
  return url.href;
}
