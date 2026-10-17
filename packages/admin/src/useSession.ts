import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch, apiTokenKey, serviceCapabilities } from './runtime';
import { AdminSession } from './session';

export function localStorageOrNull(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function useAdminSession() {
  const [session] = useState(
    () =>
      new AdminSession({
        mode: serviceCapabilities().authMode,
        fetch: apiFetch,
        storage: localStorageOrNull(),
        key: apiTokenKey('admin-token'),
      }),
  );
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    void session.refresh();
    const refresh = () => {
      if (document.visibilityState !== 'hidden') void session.refresh();
    };
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      session.cancelPending();
    };
  }, [session]);
  return { session, state };
}
