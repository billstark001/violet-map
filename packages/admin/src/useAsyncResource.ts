import { useCallback, useEffect, useRef, useState } from 'react';

/** Keep the last successful data while reloading; abort superseded/unmounted reads. */
export function useAsyncResource<T>(load: (signal: AbortSignal) => Promise<T>, initial: T) {
  const [state, setState] = useState<{ data: T; error: string | null; loading: boolean }>({
    data: initial,
    error: null,
    loading: true,
  });
  const current = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    setState((state) => ({ ...state, loading: true, error: null }));
    try {
      const data = await load(controller.signal);
      if (!controller.signal.aborted) setState({ data, error: null, loading: false });
    } catch (error) {
      if (!controller.signal.aborted)
        setState((state) => ({
          ...state,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    }
  }, [load]);
  useEffect(() => {
    void reload();
    return () => {
      current.current?.abort();
    };
  }, [reload]);
  return { ...state, reload };
}
