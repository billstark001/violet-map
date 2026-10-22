import type { ChunkDemand, ChunkSchedulerEntry } from './contracts';
import type { ViewerResourceBudget } from './resourceBudget';
import { workerResidentColumnLimit } from './resourceBudget';
import { comparePriority } from './chunkPolicy';

export const WORKER_NEIGHBOR_HOLD_MS = 3500;
const STALE_WORKER_RELEASE_MS = 4000;
const STALE_MESH_RELEASE_MS = 8000;

export interface WorkerResidencyEntry extends ChunkSchedulerEntry {
  workerPins: number;
  workerKeepUntil: number;
  contentDigest: string | null;
  estimatedColumnBytes: number;
  workerCopies: number;
}

export function workerDataReleasable(
  entry: Pick<
    WorkerResidencyEntry,
    'state' | 'workerKeepUntil' | 'workerPins' | 'pendingFull' | 'pendingLod' | 'contentDigest'
  >,
  now: number,
): boolean {
  return (
    entry.state === 'stored' &&
    now >= entry.workerKeepUntil &&
    entry.workerPins === 0 &&
    !entry.pendingFull &&
    !entry.pendingLod &&
    !!entry.contentDigest
  );
}

export function selectResidencyReleases(input: {
  entries: readonly WorkerResidencyEntry[];
  keepKeys: ReadonlySet<string>;
  workers: number;
  now: number;
  budget: ViewerResourceBudget;
  demandFor(key: string): Readonly<ChunkDemand> | undefined;
  isSatisfied(entry: ChunkSchedulerEntry): boolean;
}): { workerKeys: string[]; meshKeys: string[] } {
  const workerKeys = new Set<string>();
  const meshKeys: string[] = [];
  for (const entry of input.entries) {
    if (input.keepKeys.has(entry.key)) continue;
    const demand = input.demandFor(entry.key);
    const age = demand ? input.now - demand.wantedAt : Infinity;
    if (age > STALE_WORKER_RELEASE_MS && workerDataReleasable(entry, input.now)) workerKeys.add(entry.key);
    if (age > STALE_MESH_RELEASE_MS && entry.displayed !== 'none') meshKeys.push(entry.key);
  }
  if (!input.workers) return { workerKeys: [...workerKeys], meshKeys };
  const resident = input.entries.filter((entry) => entry.state === 'stored' && !workerKeys.has(entry.key));
  let bytes = resident.reduce((sum, entry) => sum + entry.estimatedColumnBytes * entry.workerCopies, 0);
  let count = resident.length;
  const limit = workerResidentColumnLimit(input.budget, input.workers);
  const compare = (a: WorkerResidencyEntry, b: WorkerResidencyEntry) => {
    const ad = input.demandFor(a.key),
      bd = input.demandFor(b.key);
    if (!ad || !bd) return Number(!!ad) - Number(!!bd);
    const ap = ad.boost && comparePriority(ad.boost, ad.priority) < 0 ? ad.boost : ad.priority;
    const bp = bd.boost && comparePriority(bd.boost, bd.priority) < 0 ? bd.boost : bd.priority;
    return bp.tier - ap.tier || ad.wantedAt - bd.wantedAt || bp.score - ap.score;
  };
  const victims = resident
    .filter((entry) => workerDataReleasable(entry, input.now) && input.isSatisfied(entry))
    .sort(compare);
  for (const entry of victims) {
    if (count <= limit && bytes <= input.budget.workerBytes) break;
    workerKeys.add(entry.key);
    count--;
    bytes -= entry.estimatedColumnBytes * entry.workerCopies;
  }
  return { workerKeys: [...workerKeys], meshKeys };
}
