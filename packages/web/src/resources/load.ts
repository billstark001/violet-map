import {
  RESOURCE_LOAD_TIMEOUT_MS,
  resourceLoadRetryable,
  resourceLoadRetryDelayMs,
} from '../scheduling/resourcePolicy';

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Bootstrap admission retries have one deadline and the caller's lifetime.
 * The operation must pass the supplied signal through its transport/decoder.
 */
export async function loadResource<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(RESOURCE_LOAD_TIMEOUT_MS)]);
  for (let attempt = 0; ; attempt++) {
    lifetime.throwIfAborted();
    try {
      const value = await operation(lifetime);
      lifetime.throwIfAborted();
      return value;
    } catch (error) {
      lifetime.throwIfAborted();
      if (!resourceLoadRetryable(error)) throw error;
      await waitForRetry(resourceLoadRetryDelayMs(attempt), lifetime);
    }
  }
}
