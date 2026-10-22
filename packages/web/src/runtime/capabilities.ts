import type { ViewerCapabilities } from '../scheduling/resourceBudget';

const WORKER_LIMIT_STORAGE_KEY = 'violet-map:maxMeshWorkers';

export function readViewerCapabilities(): ViewerCapabilities {
  let requestedMeshWorkers: number | null = null;
  try {
    const raw = localStorage.getItem(WORKER_LIMIT_STORAGE_KEY);
    if (raw !== null && raw.trim() !== '' && Number.isFinite(Number(raw))) requestedMeshWorkers = Number(raw);
  } catch {
    // Worker preferences are optional when browser storage is unavailable.
  }
  return {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    requestedMeshWorkers,
  };
}
