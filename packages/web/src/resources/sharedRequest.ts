import { ResourceError } from '@violet-map/core/resources';

export interface SharedRequest<T> {
  readonly controller: AbortController;
  readonly promise: Promise<T>;
  users: number;
}

/** A caller owns its wait; the transport ends only when no caller remains. */
export async function joinRequest<T>(job: SharedRequest<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  job.controller.signal.throwIfAborted();
  if (job.users >= 256) throw new ResourceError('RESOURCE_BUSY', 'too many resource request waiters', true);
  job.users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--job.users === 0) job.controller.abort();
  };
  let cancel: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        cancel = () => {
          reject(signal.reason);
          release();
        };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
      })
    : null;
  try {
    return await (aborted ? Promise.race([job.promise, aborted]) : job.promise);
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
    release();
  }
}
