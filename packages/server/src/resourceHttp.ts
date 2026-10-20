import { nonSharedByteView } from '@violet-map/core/http';
import type { ArtifactRef } from '@violet-map/core/resources';
import type { ArtifactRead } from '@violet-map/resources';
import fresh from 'fresh';
import type { Context } from 'hono';
import { parseByteRange, type ByteRange } from './httpRange.js';

/** Shared conditional and Range implementation for derived objects and authorized media originals. */
export async function artifactResponse(
  c: Context,
  artifact: ArtifactRef,
  read: (range?: ByteRange) => Promise<ArtifactRead>,
) {
  const etag = `"${artifact.digest}"`;
  const headers = {
    etag: etag,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    'content-type': artifact.mediaType,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'none'; sandbox",
  };
  if (
    fresh({ 'if-none-match': c.req.header('if-none-match'), 'cache-control': c.req.header('cache-control') }, { etag })
  )
    return c.body(null, 304, headers);
  const ifRange = c.req.header('if-range');
  const raw = c.req.method === 'GET' && (ifRange === undefined || ifRange === etag) ? c.req.header('range') : undefined;
  const range = raw === undefined ? undefined : parseByteRange(raw, artifact.bytes);
  if (raw !== undefined && !range)
    return c.body(null, 416, { ...headers, 'content-range': `bytes */${artifact.bytes}` });
  if (c.req.method === 'HEAD') return c.body(null, 200, { ...headers, 'content-length': String(artifact.bytes) });
  const lease = await read(range ?? undefined);
  let offset = 0,
    released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = c.req.raw.signal;
  let abort: () => void = () => {};
  const release = () => {
    if (!released) {
      released = true;
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      lease.release();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        release();
        controller.error(signal.reason ?? new DOMException('resource transfer aborted', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        release();
        controller.error(new DOMException('resource transfer deadline exceeded', 'TimeoutError'));
      }, 30000);
      timer.unref();
      if (signal.aborted) abort();
    },
    pull(controller) {
      if (offset >= lease.bytes.byteLength) {
        release();
        controller.close();
        return;
      }
      const end = Math.min(lease.bytes.byteLength, offset + 65536);
      lease.transfer?.(end - offset);
      controller.enqueue(nonSharedByteView(lease.bytes.subarray(offset, end)));
      offset = end;
    },
    cancel() {
      release();
    },
  });
  return c.body(stream, range ? 206 : 200, {
    ...headers,
    'content-length': String(lease.bytes.byteLength),
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${artifact.bytes}` } : {}),
  });
}
