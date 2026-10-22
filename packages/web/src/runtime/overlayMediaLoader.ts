import type { MediaVersion, OverlayMediaReference } from '@violet-map/core/overlays';
import { resourceDownloader } from '../resources/download';

export type OverlayMediaLoader<T> = (
  reference: OverlayMediaReference,
  signal: AbortSignal,
  maxTextureSize: number,
) => Promise<T>;

export function createOverlayMediaLoader<T>(
  decode: (bytes: ArrayBuffer, version: MediaVersion, signal: AbortSignal, maxTextureSize: number) => Promise<T>,
): OverlayMediaLoader<T> {
  return async (reference, signal, maxTextureSize) => {
    const bytes = await resourceDownloader.download(reference.resource, signal);
    signal.throwIfAborted();
    return decode(bytes.buffer, reference.version, signal, maxTextureSize);
  };
}
