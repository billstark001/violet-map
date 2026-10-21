/** Load a CORS-readable image, detaching listeners on every outcome. Cancellation
 * clears the source so disposed viewers stop outstanding texture downloads. */
export function loadBrowserImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      image.removeAttribute('src');
      reject(signal!.reason);
    };
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error(`failed: ${url}`));
    };
    signal?.addEventListener('abort', abort, { once: true });
    image.src = url;
  });
}
