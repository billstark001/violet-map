import type { ChunkScheduler } from '../../src/scheduling/chunkScheduler.js';
import type {
  ChunkCandidate,
  ChunkSchedulerEntry,
  LodStep,
  SchedulerViewInput,
} from '../../src/scheduling/contracts.js';
import { UNCLIPPED_VIEW } from '../../src/view/worldGeometry.js';
import type { ViewState } from '../../src/view/state.js';

export const testView: ViewState = {
  position: { x: 0, y: 80, z: 0 },
  direction: { x: 0, y: 0, z: 1 },
  projection: { kind: 'perspective', fovYRadians: Math.PI / 3, aspect: 1, zoom: 1, near: 0.1 },
  mode: 'perspective',
  clip: UNCLIPPED_VIEW,
};

/** Supply a deterministic planner result while exercising the real demand owner. */
export function planFixtureDemands(
  scheduler: ChunkScheduler,
  entries: ReadonlyMap<string, ChunkSchedulerEntry>,
  now: number,
  target: (entry: ChunkSchedulerEntry) => LodStep = () => 1,
  priority: (entry: ChunkSchedulerEntry) => { tier: number; score: number } = () => ({ tier: 0, score: 0 }),
) {
  const plan = scheduler.view.plan;
  scheduler.view.plan = (input: SchedulerViewInput) => {
    const demands: ChunkCandidate[] = [...entries.values()].map((entry) => ({
      key: entry.key,
      cx: entry.cx,
      cz: entry.cz,
      targetStep: target(entry),
      importance: 1,
      satisfaction: 0,
      gap: 1,
      ...priority(entry),
      updatedAt: input.now,
    }));
    const keys = new Set(entries.keys());
    return {
      demands,
      candidates: demands,
      keepKeys: keys,
      protectedKeys: keys,
      fullDetailKeys: keys,
      centerCx: 0,
      centerCz: 0,
    };
  };
  try {
    scheduler.tick({ view: testView, now, options: {}, keyFor: (x, z) => x + ',' + z, entries });
  } finally {
    scheduler.view.plan = plan;
  }
}
