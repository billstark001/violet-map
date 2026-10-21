/** Reject offsets and lengths that cannot be represented exactly by file and HTTP APIs. */
export function validateReadRange(start: number, length: number): void {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    start + length > Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError('invalid storage byte range');
  }
}

/** Retain only the requested window; allocation follows bytes received, not requested length.
 * Ending iteration cancels the remaining HTTP/SDK stream, including ignored Range responses. */
export async function readStreamRange(
  stream: AsyncIterable<Uint8Array>,
  start: number,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  validateReadRange(start, length);
  const chunks: Uint8Array[] = [];
  let skipped = 0,
    written = 0;
  for await (const chunk of stream) {
    const from = Math.min(chunk.byteLength, start - skipped);
    skipped += from;
    const take = Math.min(chunk.byteLength - from, length - written);
    if (take) {
      chunks.push(new Uint8Array(chunk.subarray(from, from + take)));
      written += take;
    }
    if (written === length) break;
  }
  const output = new Uint8Array(written);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Both HTTP adapters implement the same partial/ignored-range contract. */
export async function readHttpRange(response: Response, start: number, length: number): Promise<Uint8Array> {
  validateReadRange(start, length);
  let expected: number | undefined;
  if (response.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
    const first = Number(match?.[1]),
      last = Number(match?.[2]),
      total = Number(match?.[3]);
    if (
      !match ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first !== start ||
      last < first ||
      last - first >= length ||
      (match[3] !== '*' && (!Number.isSafeInteger(total) || total <= last))
    ) {
      await response.body?.cancel();
      throw new Error('invalid storage Content-Range');
    }
    expected = last - first + 1;
  } else if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`unexpected storage range status: ${response.status}`);
  }
  const bytes = response.body
    ? await readStreamRange(response.body, response.status === 200 ? start : 0, length)
    : new Uint8Array();
  if (expected !== undefined && bytes.byteLength !== expected) throw new Error('truncated storage range response');
  return bytes;
}
