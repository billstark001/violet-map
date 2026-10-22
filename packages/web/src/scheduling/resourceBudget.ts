export interface ViewerCapabilities {
  hardwareConcurrency: number;
  deviceMemoryGiB: number | null;
  requestedMeshWorkers: number | null;
}

export interface ViewerResourceBudget {
  meshWorkers: number;
  workerCopies: number;
  workerBytes: number;
  topMapResidentTiles: number;
  chunkDownloadConcurrency: number;
}

/** Hardware changes throughput/retention, never the requested full-detail radius. */
export function resolveViewerResourceBudget(capabilities: ViewerCapabilities): ViewerResourceBudget {
  const hardware = Number.isFinite(capabilities.hardwareConcurrency)
    ? Math.max(1, Math.floor(capabilities.hardwareConcurrency))
    : 2;
  const memory = capabilities.deviceMemoryGiB;
  const low = memory !== null && memory <= 4;
  const medium = memory !== null && memory <= 8;
  const defaultWorkers = low ? 1 : 2;
  const requested = capabilities.requestedMeshWorkers;
  const meshWorkers = Math.max(
    1,
    Math.min(
      4,
      hardware > 2 ? hardware - 1 : 1,
      requested !== null && Number.isFinite(requested) ? Math.floor(requested) : defaultWorkers,
    ),
  );
  return {
    meshWorkers,
    workerCopies: low ? 256 : medium ? 512 : 768,
    workerBytes: (low ? 128 : medium ? 256 : 384) * 1024 ** 2,
    topMapResidentTiles: low ? 48 : medium ? 72 : 96,
    chunkDownloadConcurrency: 4,
  };
}

export function workerResidentColumnLimit(budget: ViewerResourceBudget, workers: number): number {
  if (!Number.isSafeInteger(workers) || workers < 1) throw new RangeError('resident budgeting requires live workers');
  return Math.max(192, Math.min(1400, Math.floor(budget.workerCopies / workers)));
}
