import type { ChunkSchedulerEntry, ChunkDemand, ResolvedChunkScheduling } from './contracts';
import {
  activeCellCapacity,
  chunkWorkIdle,
  validGeometryPrecision,
  isDemandFresh,
  OUTSIDE_ACTIVE_DROP_MS,
  LOW_VALUE_ACTIVE_DROP_MS,
  LOW_VALUE_ACTIVE_EVICT_LIMIT,
  LOW_VALUE_ACTIVE_MAX_IMPORTANCE,
  LOW_VALUE_ACTIVE_MAX_GAP,
} from './chunkPolicy';

interface ChunkRetentionInput {
  keepKeys: ReadonlySet<string>;
  protectedKeys: ReadonlySet<string>;
  entries: Iterable<ChunkSchedulerEntry>;
  now: number;
  reservedSlots: number;
  config: Readonly<ResolvedChunkScheduling>;
  center: Readonly<{ cx: number; cz: number }>;
  demandFor(entry: ChunkSchedulerEntry): Readonly<ChunkDemand> | undefined;
}

export function selectChunkEvictions(input: ChunkRetentionInput): string[] {
  const { keepKeys, protectedKeys, entries, now, reservedSlots, config, center, demandFor } = input;
  function evictionVictims(entries: ChunkSchedulerEntry[], now: number, limit: number): ChunkSchedulerEntry[] {
    if (limit <= 0 || entries.length === 0) return [];

    const leastImportant = [...entries].sort((a, b) => compareLeastImportantEviction(a, b, now));
    const saturated = [...entries].sort((a, b) => compareSaturatedEviction(a, b, now));
    const out: ChunkSchedulerEntry[] = [];
    const seen = new Set<string>();
    let importanceIndex = 0;
    let saturatedIndex = 0;

    const take = (entry: ChunkSchedulerEntry | undefined): void => {
      if (entry === undefined || seen.has(entry.key) || out.length >= limit) return;
      seen.add(entry.key);
      out.push(entry);
    };

    while (out.length < limit && (importanceIndex < leastImportant.length || saturatedIndex < saturated.length)) {
      take(leastImportant[importanceIndex++]);
      take(saturated[saturatedIndex++]);
    }

    return out;
  }

  function compareLeastImportantEviction(a: ChunkSchedulerEntry, b: ChunkSchedulerEntry, now: number): number {
    const ai = evictionImportance(a);
    const bi = evictionImportance(b);
    if (ai !== bi) return ai - bi;
    return evictionScore(b, now) - evictionScore(a, now) || a.key.localeCompare(b.key);
  }

  function compareSaturatedEviction(a: ChunkSchedulerEntry, b: ChunkSchedulerEntry, now: number): number {
    const ag = evictionGap(a);
    const bg = evictionGap(b);
    if (ag !== bg) return ag - bg;

    const ap = evictionPrecision(a);
    const bp = evictionPrecision(b);
    if (ap !== bp) return bp - ap;

    const ai = evictionImportance(a);
    const bi = evictionImportance(b);
    if (ai !== bi) return ai - bi;

    return evictionScore(b, now) - evictionScore(a, now) || a.key.localeCompare(b.key);
  }

  function isLowValueActiveEntry(entry: ChunkSchedulerEntry, now: number): boolean {
    if (now - (demandFor(entry)?.wantedAt ?? 0) < LOW_VALUE_ACTIVE_DROP_MS) return false;
    if (isDemandFresh(demandFor(entry), now)) return false;
    if (Math.hypot(entry.cx - center.cx, entry.cz - center.cz) < config.fullDetailRadiusChunks + 1) {
      return false;
    }

    const importance = evictionImportance(entry);
    const gap = evictionGap(entry);
    if (importance > LOW_VALUE_ACTIVE_MAX_IMPORTANCE || gap > LOW_VALUE_ACTIVE_MAX_GAP) return false;

    // Coarse LOD islands are the common case. Also discard long-idle entries
    // that never produced a mesh, rather than letting old failed/empty work
    // occupy the tracked-chunk budget indefinitely.
    return (entry.displayed === 'lod' && entry.displayedLodStep >= 4) || entry.displayed === 'none';
  }

  function evictionImportance(entry: ChunkSchedulerEntry): number {
    const value = demandFor(entry)?.importance ?? 0;
    return Number.isFinite(value) ? value : 0;
  }

  function evictionGap(entry: ChunkSchedulerEntry): number {
    const value = demandFor(entry)?.gap;
    if (Number.isFinite(value)) return value!;
    return evictionImportance(entry) - evictionPrecision(entry);
  }

  function evictionPrecision(entry: ChunkSchedulerEntry): number {
    if (!entry.dirty && entry.state === 'absent') return 1;
    return validGeometryPrecision(entry);
  }

  function evictionScore(entry: ChunkSchedulerEntry, now: number): number {
    const age = Math.max(0, now - (demandFor(entry)?.wantedAt ?? 0)) * 0.001;
    const dx = entry.cx - center.cx;
    const dz = entry.cz - center.cz;
    const distance = Math.hypot(dx, dz);
    const score = demandFor(entry)?.priority.score ?? 0;
    const unrendered = entry.displayed === 'none' ? 2 : 0;
    const notResident = entry.state !== 'stored' ? 1 : 0;
    const rendered = entry.displayed === 'full' ? -0.8 : entry.displayed === 'lod' ? -0.35 : 0;
    return age + distance * 0.18 + score * 0.01 + unrendered + notResident + rendered;
  }

  const out: string[] = [];
  const all = [...entries];
  const releasable = all.filter(chunkWorkIdle);
  const already = new Set<string>();

  for (const entry of releasable) {
    if (keepKeys.has(entry.key)) continue;
    const age = now - (demandFor(entry)?.wantedAt ?? 0);
    if (age > OUTSIDE_ACTIVE_DROP_MS) {
      out.push(entry.key);
      already.add(entry.key);
    }
  }

  // A chunk can stay within the active disk while its attention has already
  // decayed to zero. Keeping coarse, stale islands in that case wastes both
  // resident metadata and the chance to load something useful nearby. Do not
  // touch current candidates or the critical neighborhood: those are allowed
  // to survive even when their transient tracker score is low.
  const lowValueVictims = evictionVictims(
    releasable.filter(
      (entry) =>
        keepKeys.has(entry.key) &&
        !protectedKeys.has(entry.key) &&
        !already.has(entry.key) &&
        isLowValueActiveEntry(entry, now),
    ),
    now,
    LOW_VALUE_ACTIVE_EVICT_LIMIT,
  );
  for (const victim of lowValueVictims) {
    out.push(victim.key);
    already.add(victim.key);
  }

  const activeCapacity = activeCellCapacity(config.activeRadiusChunks);
  const residentLimit = Math.min(activeCapacity, config.maxTrackedChunks);
  const existingProtectedCount = all.reduce(
    (count, entry) => count + (protectedKeys.has(entry.key) || !chunkWorkIdle(entry) ? 1 : 0),
    0,
  );
  const trackedLimit = Math.max(existingProtectedCount, residentLimit - Math.max(0, reservedSlots));
  if (all.length - out.length <= trackedLimit) return out;

  let tracked = all.length - out.length;
  const dropVictim = (victim: ChunkSchedulerEntry): void => {
    if (already.has(victim.key)) return;
    out.push(victim.key);
    already.add(victim.key);
    tracked--;
  };

  const victims = evictionVictims(
    releasable.filter((entry) => !keepKeys.has(entry.key) && !already.has(entry.key)),
    now,
    tracked - trackedLimit,
  );
  for (const victim of victims) {
    if (tracked <= trackedLimit) break;
    dropVictim(victim);
  }

  if (tracked > trackedLimit) {
    const staleActiveVictims = evictionVictims(
      releasable.filter(
        (entry) =>
          keepKeys.has(entry.key) &&
          !protectedKeys.has(entry.key) &&
          !already.has(entry.key) &&
          !isDemandFresh(demandFor(entry), now),
      ),
      now,
      tracked - trackedLimit,
    );
    for (const victim of staleActiveVictims) {
      if (tracked <= trackedLimit) break;
      dropVictim(victim);
    }
  }

  if (tracked > trackedLimit) {
    const activeVictims = evictionVictims(
      releasable.filter((entry) => keepKeys.has(entry.key) && !protectedKeys.has(entry.key) && !already.has(entry.key)),
      now,
      tracked - trackedLimit,
    );
    for (const victim of activeVictims) {
      if (tracked <= trackedLimit) break;
      dropVictim(victim);
    }
  }

  return out;
}
