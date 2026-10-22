import { selectChunkEvictions } from './chunkRetention';
import { isDemandFresh } from './chunkPolicy';
import { ChunkViewPlanner } from './chunkView';

import {
  type LodStep,
  type ChunkSchedulerOptions,
  type ChunkPriority,
  type MeshTask,
  type ChunkCandidate,
  type ChunkSchedulerEntry,
  type SchedulerEntryUpdate,
  type SchedulerAction,
  type SchedulerTickInput,
  type SchedulerTickResult,
  type SchedulerWorkInput,
  type SchedulerWorkBatch,
  type SchedulerEvent,
  type SchedulerMeshResult,
  type ChunkSchedulerStats,
  type ChunkSchedulerDiagnosticSnapshot,
} from './contracts';
import {
  MAX_HASH_BATCHES,
  HASH_BATCH_SIZE,
  MAX_FETCH_BATCHES,
  FETCH_BATCH_SIZE,
  BLOCKED_RENDER_HASH_BATCH_SIZE,
  BLOCKED_RENDER_FETCH_BATCH_SIZE,
  MAX_IO_QUEUE,
  MAX_MESH_QUEUE,
  IO_QUEUE_RETENTION_MS,
  RECORD_RETENTION_MS,
  MESH_RETRY_COOLDOWN_MS,
  IO_RENDER_SHARE_TARGET,
  MIN_EXISTING_CHUNKS_BEFORE_BALANCE,
  RENDER_BACKLOG_IO_PAUSE,
  normalizeLodStep,
  trackerTimeSeconds,
  meshSatisfiesTarget,
  meshMatchesTarget,
  compareMeshTaskPriority,
  comparePriority,
} from './chunkPolicy';

interface ChunkWorkload {
  backlog: number;
  resident: number;
  readyShare: number;
}

function priorityKey(task: Pick<MeshTask, 'key' | 'kind'>): string {
  return `${task.key}\u0000${task.kind}`;
}

export class ChunkScheduler {
  readonly view = new ChunkViewPlanner();
  private hashQueue = new Set<string>();
  private fetchQueue = new Set<string>();
  private meshQueue = new Map<string, MeshTask>();
  private meshCooldownUntil = new Map<string, number>();
  private priorityByKey = new Map<string, ChunkPriority>();
  private recordByKey = new Map<string, SchedulerEntryUpdate>();

  constructor(private opts: ChunkSchedulerOptions = {}) {}

  queueStats(): Pick<ChunkSchedulerStats, 'hashQueued' | 'fetchQueued' | 'meshQueued' | 'trackedPriorities'> {
    return {
      hashQueued: this.hashQueue.size,
      fetchQueued: this.fetchQueue.size,
      meshQueued: this.meshQueue.size,
      trackedPriorities: this.recordByKey.size,
    };
  }

  diagnosticSnapshot(now: number): ChunkSchedulerDiagnosticSnapshot {
    return {
      capturedAt: now,
      center: { cx: this.view.center.cx, cz: this.view.center.cz },
      activeRadiusChunks: this.view.config.activeRadiusChunks,
      maxCandidates: this.view.config.maxCandidates,
      trackedChunkLimit: this.view.config.maxTrackedChunks,
      lodDisabled: this.lodDisabled(),
      fullDetailRadiusChunks: this.view.config.fullDetailRadiusChunks,
      nearPresenceRadiusChunks: this.view.config.nearPresenceRadiusChunks,
      queues: {
        hash: [...this.hashQueue].sort((a, b) => this.compareQueuedKeys(a, b)),
        fetch: [...this.fetchQueue].sort((a, b) => this.compareQueuedKeys(a, b)),
        mesh: [...this.meshQueue.values()].sort((a, b) => compareMeshTaskPriority(a, b)),
      },
      trackedPriorities: this.recordByKey.size,
    };
  }

  clear() {
    this.hashQueue.clear();
    this.fetchQueue.clear();
    this.meshQueue.clear();
    this.meshCooldownUntil.clear();
    this.priorityByKey.clear();
    this.recordByKey.clear();
    this.view.clear();
  }

  tick(input: SchedulerTickInput): SchedulerTickResult {
    this.opts = input.options;
    const frame = this.view.plan(input);
    const actions: SchedulerAction[] = [];
    const entryUpdates: SchedulerEntryUpdate[] = [];
    let newCandidateCount = 0;

    for (const candidate of frame.candidates) {
      const entry = input.entries.get(candidate.key) ?? null;
      const update = this.rememberRecord(candidate);
      this.rememberPriority(candidate.key, candidate);
      entryUpdates.push(update);

      if (!entry) {
        newCandidateCount++;
        this.enqueueIo(this.hashQueue, candidate.key);
        actions.push({ type: 'wantChunk', key: candidate.key, cx: candidate.cx, cz: candidate.cz });
        continue;
      }

      this.scheduleCandidate(candidate, entry);
    }

    this.pruneQueues(input.now, input.entries);
    this.expirePriorities(input.now);

    const evictedKeys = selectChunkEvictions({
      keepKeys: frame.keepKeys,
      protectedKeys: frame.protectedKeys,
      entries: input.entries.values(),
      now: input.now,
      reservedSlots: newCandidateCount,
      config: this.view.config,
      center: this.view.center,
      demandFor: (entry) => this.recordFor(entry),
    });
    for (const key of evictedKeys) actions.push({ type: 'dropChunk', key });

    return {
      actions,
      entryUpdates,
      keepKeys: frame.keepKeys,
      centerCx: frame.centerCx,
      centerCz: frame.centerCz,
      candidateCount: frame.candidates.length,
      evictedCount: evictedKeys.length,
    };
  }

  nextWork(input: SchedulerWorkInput): SchedulerWorkBatch {
    const includeHash = input.includeHash ?? true;
    const includeFetch = input.includeFetch ?? true;
    const includeMesh = input.includeMesh ?? true;
    const hashBatches: string[][] = [];
    const fetchBatches: string[][] = [];
    const meshTasks: MeshTask[] = [];

    const workload = includeHash || includeFetch ? this.workload(input) : null;
    if (includeHash && workload) {
      const batch = this.nextHashBatch(input, workload);
      if (batch.length) hashBatches.push(batch);
    }

    if (includeFetch && workload) {
      const batch = this.nextFetchBatch(input, workload);
      if (batch.length) fetchBatches.push(batch);
    }

    if (includeMesh) {
      const selectedMeshKeys = new Set<string>();
      while (input.activeMeshTasks + meshTasks.length < input.maxMeshTasks) {
        const task = this.nextMeshTask(input.entries, input.now, selectedMeshKeys);
        if (!task) break;
        selectedMeshKeys.add(task.key);
        meshTasks.push(task);
      }
    }

    return {
      hashBatches,
      fetchBatches,
      meshTasks,
      hashWakeAt:
        includeHash && input.activeHashBatches + hashBatches.length < MAX_HASH_BATCHES
          ? this.ioWakeAt(this.hashQueue, input.entries, 'checking', input.now)
          : null,
      fetchWakeAt:
        includeFetch && input.activeFetchBatches + fetchBatches.length < MAX_FETCH_BATCHES
          ? this.ioWakeAt(this.fetchQueue, input.entries, 'hashed', input.now)
          : null,
    };
  }

  notify(event: SchedulerEvent): SchedulerEntryUpdate | undefined {
    switch (event.type) {
      case 'hashNeeded':
        if (event.priority) this.rememberPriority(event.key, event.priority);
        this.enqueueIo(this.hashQueue, event.key);
        return;
      case 'fetchNeeded':
        if (event.priority) this.rememberPriority(event.key, event.priority);
        this.enqueueIo(this.fetchQueue, event.key);
        return;
      case 'meshDeferred': {
        const priority = this.priorityByKey.get(event.key) ?? {
          tier: event.fallbackTier,
          score: 0,
          updatedAt: event.now,
        };
        this.enqueueMeshTask({ key: event.key, kind: event.kind, step: event.step, ...priority });
        return;
      }
      case 'meshInvalidated':
        return this.scheduleInvalidatedMesh(event.entry, event.now);
      case 'chunkStored':
        this.view.syncEntry(event.entry, trackerTimeSeconds(event.now));
        return;
      case 'meshDisplayed':
        this.view.syncEntry(event.entry, trackerTimeSeconds(event.now));
        this.meshCooldownUntil.delete(event.entry.key);
        return;
      case 'chunkDropped':
        this.deleteKey(event.key);
        return;
    }
  }

  shouldAcceptMeshResult(result: SchedulerMeshResult): boolean {
    if (result.version < result.entry.displayedVersion) return false;
    if (!isDemandFresh(this.recordFor(result.entry), result.now)) return false;
    return meshMatchesTarget(result.kind, result.step, this.lastTargetStep(result.entry), this.lodDisabled());
  }

  private scheduleCandidate(candidate: ChunkCandidate, entry: ChunkSchedulerEntry): void {
    if (entry.state === 'checking' && this.entryNeedsMoreForLastTarget(entry))
      this.enqueueIo(this.hashQueue, candidate.key);
  }

  private nextHashBatch(input: SchedulerWorkInput, workload: ChunkWorkload): string[] {
    if (input.activeHashBatches >= MAX_HASH_BATCHES) return [];
    const batchSize = this.shouldLoadMore(input, workload)
      ? this.ioBatchSize(HASH_BATCH_SIZE, workload)
      : BLOCKED_RENDER_HASH_BATCH_SIZE;
    return this.nextIoBatch(
      this.hashQueue,
      batchSize,
      (entry) => entry?.state === 'checking',
      input.entries,
      input.now,
    );
  }

  private nextFetchBatch(input: SchedulerWorkInput, workload: ChunkWorkload): string[] {
    if (input.activeFetchBatches >= MAX_FETCH_BATCHES) return [];
    const batchSize = this.shouldLoadMore(input, workload)
      ? this.ioBatchSize(FETCH_BATCH_SIZE, workload)
      : BLOCKED_RENDER_FETCH_BATCH_SIZE;
    return this.nextIoBatch(this.fetchQueue, batchSize, (entry) => entry?.state === 'hashed', input.entries, input.now);
  }

  private nextMeshTask(
    entries: ReadonlyMap<string, ChunkSchedulerEntry>,
    now: number,
    selectedKeys: ReadonlySet<string>,
  ): MeshTask | null {
    let best: MeshTask | null = null;
    let bestQueueKey: string | null = null;

    for (const task of this.meshQueue.values()) {
      const queueKey = priorityKey(task);
      const entry = entries.get(task.key);
      if (!entry || (entry.state !== 'stored' && entry.state !== 'hashed')) {
        this.meshQueue.delete(queueKey);
        continue;
      }
      if (selectedKeys.has(task.key) || this.meshOnCooldown(task.key, now)) continue;
      if (!this.shouldStartMeshTask(task, entry, now)) {
        this.meshQueue.delete(queueKey);
        continue;
      }
      const queued = this.withLatestPriority(task);
      if (!best || compareMeshTaskPriority(queued, best) < 0) {
        best = queued;
        bestQueueKey = queueKey;
      }
    }

    for (const entry of entries.values()) {
      if (selectedKeys.has(entry.key) || this.meshOnCooldown(entry.key, now)) continue;
      if (entry.state !== 'stored' && entry.state !== 'hashed') continue;
      const task = this.desiredMeshTaskForEntry(entry, now);
      if (!task) continue;
      if (!best || compareMeshTaskPriority(task, best) < 0) {
        best = task;
        bestQueueKey = null;
      }
    }

    if (bestQueueKey) this.meshQueue.delete(bestQueueKey);
    if (best) this.cooldownMesh(best.key, now);
    return best;
  }

  private nextIoBatch(
    queue: Set<string>,
    batchSize: number,
    entryIsValid: (entry: ChunkSchedulerEntry | null) => boolean,
    entries: ReadonlyMap<string, ChunkSchedulerEntry>,
    now: number,
  ): string[] {
    const out: string[] = [];
    const keys = [...queue].sort((a, b) => this.compareQueuedKeys(a, b));

    for (const key of keys) {
      if (out.length >= batchSize) break;
      const entry = entries.get(key) ?? null;
      if (!entryIsValid(entry)) {
        queue.delete(key);
        continue;
      }
      if ((entry?.retryAt ?? 0) > now) continue;
      queue.delete(key);
      out.push(key);
    }

    return out;
  }

  private ioWakeAt(
    queue: ReadonlySet<string>,
    entries: ReadonlyMap<string, ChunkSchedulerEntry>,
    state: 'checking' | 'hashed',
    now: number,
  ): number | null {
    let wakeAt = Infinity;
    for (const key of queue) {
      const entry = entries.get(key);
      if (entry?.state === state && (entry.retryAt ?? 0) > now) wakeAt = Math.min(wakeAt, entry.retryAt!);
    }
    return Number.isFinite(wakeAt) ? wakeAt : null;
  }

  private workload(input: SchedulerWorkInput): ChunkWorkload {
    const backlog = new Set<string>();
    let resident = 0,
      ready = 0,
      tracked = 0;
    for (const entry of input.entries.values()) {
      tracked++;
      if (entry.state === 'stored' || entry.state === 'decoding') resident++;
      const target = this.lastTargetStep(entry);
      const satisfied = entry.state === 'absent' || meshSatisfiesTarget(entry, target, this.lodDisabled());
      if (satisfied) ready++;
      if (
        entry.state === 'stored' &&
        !entry.pendingFull &&
        !entry.pendingLod &&
        isDemandFresh(this.recordFor(entry), input.now) &&
        !satisfied
      )
        backlog.add(entry.key);
    }
    for (const task of this.meshQueue.values()) backlog.add(task.key);
    return { backlog: backlog.size, resident, readyShare: tracked ? ready / tracked : 0 };
  }

  private shouldLoadMore(input: SchedulerWorkInput, workload: ChunkWorkload): boolean {
    if (workload.backlog > RENDER_BACKLOG_IO_PAUSE && input.activeMeshTasks < input.maxMeshTasks) return false;
    return (
      workload.resident < MIN_EXISTING_CHUNKS_BEFORE_BALANCE ||
      workload.backlog <= RENDER_BACKLOG_IO_PAUSE ||
      workload.readyShare >= IO_RENDER_SHARE_TARGET
    );
  }

  private ioBatchSize(base: number, workload: ChunkWorkload): number {
    return workload.backlog <= RENDER_BACKLOG_IO_PAUSE ? base : Math.max(4, Math.floor(base / 2));
  }

  private enqueueIo(queue: Set<string>, key: string) {
    queue.add(key);
    this.trimQueue(queue, MAX_IO_QUEUE);
  }

  private enqueueMeshTask(task: MeshTask) {
    if (this.lodDisabled() && task.kind !== 'full') return;

    const key = priorityKey(task);
    const existing = this.meshQueue.get(key);
    if (existing && comparePriority(existing, task) <= 0) return;

    this.meshQueue.set(key, task);
    this.trimMeshQueue();
  }

  private desiredMeshTaskForEntry(entry: ChunkSchedulerEntry, now: number): MeshTask | null {
    if (entry.pendingFull || entry.pendingLod || (entry.retryAt ?? 0) > now) return null;
    const record = this.recordFor(entry);
    if (!record || now - record.lastWantedAt > IO_QUEUE_RETENTION_MS) return null;
    const priority = this.priorityByKey.get(entry.key) ?? {
      tier: record.lastTier,
      score: record.lastScore,
      updatedAt: record.lastWantedAt,
    };
    const targetStep = this.lodDisabled() ? 1 : record.lastTargetStep;

    if (targetStep === 1) {
      if (entry.pendingFull || (entry.displayed === 'full' && !entry.dirty)) return null;
      return { key: entry.key, kind: 'full', step: 1, ...priority };
    }

    if (this.lodDisabled()) return null;
    if (entry.pendingLod && entry.pendingLodStep > 0 && entry.pendingLodStep <= targetStep && !entry.dirty) return null;
    if (entry.displayed === 'lod' && entry.displayedLodStep > 0 && entry.displayedLodStep <= targetStep && !entry.dirty)
      return null;
    return { key: entry.key, kind: 'lod', step: targetStep, ...priority };
  }

  private shouldStartMeshTask(task: MeshTask, entry: ChunkSchedulerEntry, now: number): boolean {
    if (entry.pendingFull || entry.pendingLod || (entry.retryAt ?? 0) > now) return false;
    if (!isDemandFresh(this.recordFor(entry), now)) return false;
    const target = this.lastTargetStep(entry);

    if (!meshMatchesTarget(task.kind, task.step, target, this.lodDisabled())) return false;
    if (task.kind === 'full') return entry.displayed !== 'full' || entry.dirty;
    return entry.dirty || entry.displayed !== 'lod' || entry.displayedLodStep > task.step;
  }

  private meshOnCooldown(key: string, now: number): boolean {
    const until = this.meshCooldownUntil.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    this.meshCooldownUntil.delete(key);
    return false;
  }

  private cooldownMesh(key: string, now: number) {
    this.meshCooldownUntil.set(key, now + MESH_RETRY_COOLDOWN_MS);
  }

  private pruneQueues(now: number, entries: ReadonlyMap<string, ChunkSchedulerEntry>) {
    const keepQueued = (key: string): boolean => this.priorityFreshByKey(key, now) || this.recordFreshByKey(key, now);

    for (const key of this.hashQueue) {
      const entry = entries.get(key) ?? null;
      if (!keepQueued(key) || entry?.state !== 'checking') this.hashQueue.delete(key);
    }

    for (const key of this.fetchQueue) {
      const entry = entries.get(key) ?? null;
      if (!keepQueued(key) || entry?.state !== 'hashed') this.fetchQueue.delete(key);
    }

    for (const [queueKey, task] of this.meshQueue) {
      if (!keepQueued(task.key)) {
        this.meshQueue.delete(queueKey);
        continue;
      }
      const entry = entries.get(task.key);
      if (
        !entry ||
        (entry.state !== 'stored' && entry.state !== 'hashed') ||
        !this.shouldStartMeshTask(task, entry, now)
      ) {
        this.meshQueue.delete(queueKey);
      }
    }
  }

  private expirePriorities(now: number) {
    for (const [key, priority] of this.priorityByKey) {
      if (now - priority.updatedAt > RECORD_RETENTION_MS) this.priorityByKey.delete(key);
    }

    for (const [key, record] of this.recordByKey) {
      if (now - record.lastWantedAt > RECORD_RETENTION_MS && !this.hashQueue.has(key) && !this.fetchQueue.has(key)) {
        this.recordByKey.delete(key);
      }
    }

    for (const [key, until] of this.meshCooldownUntil) {
      if (now >= until + MESH_RETRY_COOLDOWN_MS) this.meshCooldownUntil.delete(key);
    }
  }

  private deleteKey(key: string) {
    this.hashQueue.delete(key);
    this.fetchQueue.delete(key);
    for (const [queueKey, task] of this.meshQueue) {
      if (task.key === key) this.meshQueue.delete(queueKey);
    }
    this.meshCooldownUntil.delete(key);
    this.priorityByKey.delete(key);
    this.recordByKey.delete(key);
  }

  private scheduleInvalidatedMesh(entry: ChunkSchedulerEntry, now: number): SchedulerEntryUpdate {
    const previous = this.recordFor(entry);
    // Invalidations repair the current camera demand; they never invent a
    // separate quality target from a stale displayed mesh.
    const targetStep = this.lodDisabled() ? 1 : normalizeLodStep(previous?.lastTargetStep ?? entry.lastTargetStep, 8);
    const priority: ChunkPriority = {
      // A boundary change affects visible geometry. Put it ahead of ordinary
      // background work, without leapfrogging the critical camera cell tier.
      tier: Math.min(previous?.lastTier ?? entry.lastTier, 0),
      score: Math.min(previous?.lastScore ?? entry.lastScore, -180),
      updatedAt: now,
    };
    const record: SchedulerEntryUpdate = {
      key: entry.key,
      cx: entry.cx,
      cz: entry.cz,
      lastWantedAt: now,
      lastTier: priority.tier,
      lastScore: priority.score,
      lastTargetStep: targetStep,
      lastForcedFull: targetStep === 1,
      lastImportance: previous?.lastImportance ?? entry.lastImportance,
      lastSatisfaction: previous?.lastSatisfaction ?? entry.lastSatisfaction,
      lastGap: previous?.lastGap ?? entry.lastGap,
    };
    this.recordByKey.set(entry.key, record);
    this.rememberPriority(entry.key, priority);
    this.view.syncEntry(entry, trackerTimeSeconds(now));

    if (entry.state === 'checking') {
      this.enqueueIo(this.hashQueue, entry.key);
      return record;
    }
    if (entry.state !== 'stored' && entry.state !== 'hashed') return record;
    this.enqueueMeshTask({
      key: entry.key,
      kind: targetStep === 1 ? 'full' : 'lod',
      step: targetStep,
      ...priority,
    });
    return record;
  }

  private rememberRecord(candidate: ChunkCandidate): SchedulerEntryUpdate {
    const record: SchedulerEntryUpdate = {
      key: candidate.key,
      cx: candidate.cx,
      cz: candidate.cz,
      lastWantedAt: candidate.updatedAt,
      lastTier: candidate.tier,
      lastScore: candidate.score,
      lastTargetStep: candidate.targetStep,
      lastForcedFull: candidate.targetStep === 1,
      lastImportance: candidate.importance,
      lastSatisfaction: candidate.satisfaction,
      lastGap: candidate.gap,
    };
    this.recordByKey.set(candidate.key, record);
    return record;
  }

  private recordFor(entry: ChunkSchedulerEntry): SchedulerEntryUpdate | null {
    return this.recordByKey.get(entry.key) ?? (Number.isFinite(entry.lastWantedAt) ? entry : null);
  }

  private rememberPriority(key: string, priority: ChunkPriority) {
    this.priorityByKey.set(key, {
      tier: priority.tier,
      score: priority.score,
      updatedAt: priority.updatedAt,
    });
  }

  private compareQueuedKeys(a: string, b: string): number {
    const ap = this.priorityByKey.get(a) ?? { tier: 99, score: Infinity, updatedAt: 0 };
    const bp = this.priorityByKey.get(b) ?? { tier: 99, score: Infinity, updatedAt: 0 };
    return comparePriority(ap, bp) || a.localeCompare(b);
  }

  private withLatestPriority(task: MeshTask): MeshTask {
    const latest = this.priorityByKey.get(task.key);
    if (!latest) return task;
    return {
      ...task,
      tier: Math.min(task.tier, latest.tier),
      score: Math.min(task.score, latest.score),
      updatedAt: latest.updatedAt,
    };
  }

  private trimQueue(queue: Set<string>, limit: number) {
    if (queue.size <= limit) return;
    const kept = [...queue].sort((a, b) => this.compareQueuedKeys(a, b)).slice(0, limit);
    queue.clear();
    for (const key of kept) queue.add(key);
  }

  private trimMeshQueue() {
    if (this.meshQueue.size <= MAX_MESH_QUEUE) return;
    const kept = [...this.meshQueue.values()].sort((a, b) => comparePriority(a, b)).slice(0, MAX_MESH_QUEUE);
    this.meshQueue.clear();
    for (const task of kept) this.meshQueue.set(priorityKey(task), task);
  }

  private priorityFreshByKey(key: string, now: number): boolean {
    const priority = this.priorityByKey.get(key);
    return !!priority && now - priority.updatedAt <= IO_QUEUE_RETENTION_MS;
  }

  private recordFreshByKey(key: string, now: number): boolean {
    const record = this.recordByKey.get(key);
    return !!record && now - record.lastWantedAt <= IO_QUEUE_RETENTION_MS;
  }

  private lastTargetStep(entry: ChunkSchedulerEntry): LodStep {
    if (this.lodDisabled()) return 1;
    return this.recordFor(entry)?.lastTargetStep ?? 8;
  }

  private entryNeedsMoreForLastTarget(entry: ChunkSchedulerEntry): boolean {
    return !meshSatisfiesTarget(entry, this.lastTargetStep(entry), this.lodDisabled());
  }

  private lodDisabled(): boolean {
    return this.opts.disableLod === true;
  }
}
