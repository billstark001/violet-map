/** Shared transport policy; authorization and endpoint semantics stay in the protocol adapter. */
export function storageRequest(url: string, options: RequestInit): Promise<Response> {
  return fetch(url, { ...options, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(30_000) });
}
