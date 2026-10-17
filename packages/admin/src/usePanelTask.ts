import { useRef, useState } from 'react';

export type PanelMessage = { ok: boolean; text: string } | null;

/** Serialize user actions in a panel and surface network/HTTP failures locally. */
export function usePanelTask() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<PanelMessage>(null);
  const run = async (work: () => Promise<void>) => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await work();
      return true;
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { busy, message, setMessage, run };
}
