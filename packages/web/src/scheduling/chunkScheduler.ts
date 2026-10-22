import { surfaceRepresentationAllowed } from '../view/representation';
import { selectChunkEvictions } from './chunkRetention';
import { ChunkViewPlanner } from './chunkView';
import type {
  ChunkDemand,
  ChunkCandidate,
  ChunkPriority,
  ChunkSchedulerEntry,
  SchedulerTickInput,
  SchedulerTickResult,
  SchedulerWorkInput,
  SchedulerWorkBatch,
  SchedulerEvent,
  SchedulerMeshResult,
  MeshTask,
  WorkerDispatchInput,
  WorkerDispatchPlan,
  ChunkSchedulerDiagnosticSnapshot,
  SchedulerAction,
  SchedulerQueueStats,
  SchedulerCellDiagnostic,
} from './contracts';
import {
  MAX_HASH_BATCHES,
  HASH_BATCH_SIZE,
  MAX_FETCH_BATCHES,
  FETCH_BATCH_SIZE,
  BLOCKED_RENDER_HASH_BATCH_SIZE,
  BLOCKED_RENDER_FETCH_BATCH_SIZE,
  MAX_IO_QUEUE,
  IO_QUEUE_RETENTION_MS,
  RECORD_RETENTION_MS,
  MESH_RETRY_COOLDOWN_MS,
  IO_RENDER_SHARE_TARGET,
  MIN_EXISTING_CHUNKS_BEFORE_BALANCE,
  RENDER_BACKLOG_IO_PAUSE,
  isDemandFresh,
  trackerTimeSeconds,
  meshSatisfiesTarget,
  meshMatchesTarget,
  comparePriority,
  compareMeshTaskPriority,
} from './chunkPolicy';

interface Workload {
  backlog: number;
  resident: number;
  readyShare: number;
}

/** Owns demand and every priority decision, including the final Worker dispatch. */
export class ChunkScheduler {
  private readonly viewPlanner = new ChunkViewPlanner();
  private readonly demands = new Map<string, ChunkDemand>();
  private readonly hashQueue = new Set<string>();
  private readonly fetchQueue = new Set<string>();

  private lodDisabled = false;

  demandFor(key: string): Readonly<ChunkDemand> | undefined {
    return this.demands.get(key);
  }

  cellDiagnostic(cx: number, cz: number): SchedulerCellDiagnostic | null {
    return this.viewPlanner.diagnosticCell(cx, cz);
  }

  queueStats(entries: ReadonlyMap<string, ChunkSchedulerEntry>, now: number): SchedulerQueueStats {
    return {
      hashQueued: this.hashQueue.size,
      fetchQueued: this.fetchQueue.size,
      meshQueued: this.meshTaskCount(entries, now),
      trackedPriorities: this.demands.size,
    };
  }

  diagnosticSnapshot(now: number, entries: ReadonlyMap<string, ChunkSchedulerEntry>): ChunkSchedulerDiagnosticSnapshot {
    return {
      capturedAt: now,
      attention: this.viewPlanner.attentionStats,
      center: { ...this.viewPlanner.center },
      activeRadiusChunks: this.viewPlanner.config.activeRadiusChunks,
      maxCandidates: this.viewPlanner.config.maxCandidates,
      trackedChunkLimit: this.viewPlanner.config.maxTrackedChunks,
      lodDisabled: this.lodDisabled,
      fullDetailRadiusChunks: this.viewPlanner.config.fullDetailRadiusChunks,
      nearPresenceRadiusChunks: this.viewPlanner.config.nearPresenceRadiusChunks,
      queues: {
        hash: this.orderedKeys(this.hashQueue),
        fetch: this.orderedKeys(this.fetchQueue),
        mesh: this.meshTasks(entries, now),
      },
      trackedPriorities: this.demands.size,
    };
  }

  clear() {
    this.demands.clear();
    this.hashQueue.clear();
    this.fetchQueue.clear();
    this.viewPlanner.clear();
  }

  tick(input: SchedulerTickInput): SchedulerTickResult {
    const options = {
      ...input.options,
      disableLod: input.options.disableLod === true || !surfaceRepresentationAllowed(input.view.mode, input.view.clip),
    };
    this.lodDisabled = options.disableLod;
    const frame = this.viewPlanner.plan({ ...input, options, demands: this.demands });
    const actions: SchedulerAction[] = [];
    let newCandidates = 0;
    for (const candidate of frame.demands) this.rememberDemand(candidate, input.entries.get(candidate.key));
    for (const candidate of frame.candidates) {
      const entry = input.entries.get(candidate.key);
      if (!entry) {
        newCandidates++;
        this.enqueue(this.hashQueue, candidate.key);
        actions.push({ type: 'wantChunk', key: candidate.key, cx: candidate.cx, cz: candidate.cz });
      } else if (entry.state === 'checking' && !this.entrySatisfied(entry)) {
        this.enqueue(this.hashQueue, entry.key);
      }
    }
    this.prune(input.entries, input.now);
    const evicted = selectChunkEvictions({
      keepKeys: frame.keepKeys,
      protectedKeys: frame.protectedKeys,
      entries: input.entries.values(),
      now: input.now,
      reservedSlots: newCandidates,
      config: this.viewPlanner.config,
      center: this.viewPlanner.center,
      demandFor: (entry) => this.demands.get(entry.key),
    });
    for (const key of evicted) actions.push({ type: 'dropChunk', key });
    return {
      actions,
      keepKeys: frame.keepKeys,
      fullDetailKeys: frame.fullDetailKeys,
      centerCx: frame.centerCx,
      centerCz: frame.centerCz,
      candidateCount: frame.candidates.length,
      evictedCount: evicted.length,
    };
  }

  nextWork(input: SchedulerWorkInput): SchedulerWorkBatch {
    this.prune(input.entries, input.now);
    const takeHash =
      input.includeHash !== false && input.activeHashBatches < MAX_HASH_BATCHES && this.hashQueue.size > 0;
    const takeFetch =
      input.includeFetch !== false && input.activeFetchBatches < MAX_FETCH_BATCHES && this.fetchQueue.size > 0;
    const meshSlots = input.includeMesh !== false ? Math.max(0, input.maxMeshTasks - input.activeMeshTasks) : 0;
    const candidates = meshSlots > 0 ? this.meshTasks(input.entries, input.now) : [];
    let hash: string[] = [],
      fetch: string[] = [];
    if (takeHash || takeFetch) {
      const backlog = meshSlots > 0 ? candidates.length : this.meshTaskCount(input.entries, input.now);
      const workload = this.workload(input.entries, backlog);
      const loadMore =
        !(workload.backlog > RENDER_BACKLOG_IO_PAUSE && input.activeMeshTasks < input.maxMeshTasks) &&
        (workload.resident < MIN_EXISTING_CHUNKS_BEFORE_BALANCE ||
          workload.backlog <= RENDER_BACKLOG_IO_PAUSE ||
          workload.readyShare >= IO_RENDER_SHARE_TARGET);
      const batchSize = (base: number, blocked: number) =>
        loadMore ? (workload.backlog <= RENDER_BACKLOG_IO_PAUSE ? base : Math.max(4, Math.floor(base / 2))) : blocked;
      if (takeHash)
        hash = this.takeIo(
          this.hashQueue,
          input,
          'checking',
          batchSize(HASH_BATCH_SIZE, BLOCKED_RENDER_HASH_BATCH_SIZE),
        );
      if (takeFetch)
        fetch = this.takeIo(
          this.fetchQueue,
          input,
          'hashed',
          batchSize(FETCH_BATCH_SIZE, BLOCKED_RENDER_FETCH_BATCH_SIZE),
        );
    }
    const mesh = candidates.slice(0, meshSlots);
    for (const task of mesh) {
      const demand = this.demands.get(task.key)!;
      this.demands.set(task.key, { ...demand, meshRetryAt: input.now + MESH_RETRY_COOLDOWN_MS });
    }
    return {
      hashBatches: hash.length ? [hash] : [],
      fetchBatches: fetch.length ? [fetch] : [],
      meshTasks: mesh,
      hashWakeAt:
        input.includeHash !== false && input.activeHashBatches + Number(hash.length > 0) < MAX_HASH_BATCHES
          ? this.ioWakeAt(this.hashQueue, input.entries, input.now)
          : null,
      fetchWakeAt:
        input.includeFetch !== false && input.activeFetchBatches + Number(fetch.length > 0) < MAX_FETCH_BATCHES
          ? this.ioWakeAt(this.fetchQueue, input.entries, input.now)
          : null,
    };
  }

  dispatchWorkers(input: WorkerDispatchInput): WorkerDispatchPlan {
    const discard: number[] = [];
    const ready = input.ready.filter((task) => {
      if (
        input.entries.get(task.entry.key) !== task.entry ||
        !this.shouldAcceptMeshResult({ ...task, now: input.now })
      ) {
        discard.push(task.version);
        return false;
      }
      return task.entry.state === 'stored';
    });
    ready.sort((a, b) => {
      const ap = this.priorityFor(this.demands.get(a.entry.key)!);
      const bp = this.priorityFor(this.demands.get(b.entry.key)!);
      return comparePriority(ap, bp) || a.step - b.step || a.version - b.version;
    });
    const loads = [...input.workerLoads];
    const activeTasks = loads.reduce((sum, load) => sum + load, 0);
    const start = ready.slice(0, Math.max(0, Math.min(input.maxTasks, loads.length) - activeTasks)).map((task) => {
      let workerIndex = 0;
      for (let i = 1; i < loads.length; i++) if (loads[i] < loads[workerIndex]) workerIndex = i;
      loads[workerIndex]++;
      return { task, workerIndex };
    });
    return { start, discard };
  }

  notify(event: SchedulerEvent): void {
    switch (event.type) {
      case 'hashNeeded':
        this.enqueue(this.hashQueue, event.key);
        return;
      case 'fetchNeeded':
        this.enqueue(this.fetchQueue, event.key);
        return;
      case 'dependencyNeeded': {
        const center = this.demands.get(event.centerKey),
          demand = this.demands.get(event.key);
        if (!center || !demand || !isDemandFresh(center, event.now)) return;
        const priority = this.priorityFor(center);
        const boost = {
          reason: 'dependency' as const,
          tier: Math.min(priority.tier, 1),
          score: priority.score + Math.hypot(center.cx - demand.cx, center.cz - demand.cz) * 0.1 + 6,
          updatedAt: event.now,
        };
        this.demands.set(event.key, { ...demand, boost });
        return;
      }
      case 'meshDeferred': {
        const demand = this.demands.get(event.key);
        if (demand) this.demands.set(event.key, { ...demand, meshRetryAt: event.now + MESH_RETRY_COOLDOWN_MS });
        return;
      }
      case 'meshInvalidated': {
        const demand = this.demands.get(event.entry.key);
        if (!demand || !isDemandFresh(demand, event.now)) return;
        this.demands.set(event.entry.key, {
          ...demand,
          meshRetryAt: 0,
          boost: {
            reason: 'repair',
            tier: Math.min(demand.priority.tier, 0),
            score: Math.min(demand.priority.score, -180),
            updatedAt: event.now,
          },
        });
        this.viewPlanner.syncEntry(event.entry, trackerTimeSeconds(event.now));
        return;
      }
      case 'chunkStored': {
        const demand = this.demands.get(event.entry.key);
        if (demand?.boost?.reason === 'dependency')
          this.demands.set(event.entry.key, { ...demand, boost: null, meshRetryAt: 0 });
        this.viewPlanner.syncEntry(event.entry, trackerTimeSeconds(event.now));
        return;
      }
      case 'meshDisplayed': {
        const demand = this.demands.get(event.entry.key);
        if (demand) this.demands.set(event.entry.key, { ...demand, boost: null, meshRetryAt: 0 });
        this.viewPlanner.syncEntry(event.entry, trackerTimeSeconds(event.now));
        return;
      }
      case 'chunkDropped':
        this.hashQueue.delete(event.key);
        this.fetchQueue.delete(event.key);
        this.demands.delete(event.key);
        return;
    }
  }

  shouldAcceptMeshResult(result: SchedulerMeshResult): boolean {
    const demand = this.demands.get(result.entry.key);
    return (
      !!demand &&
      isDemandFresh(demand, result.now) &&
      result.version >= result.entry.displayedVersion &&
      meshMatchesTarget(result.kind, result.step, demand.targetStep, this.lodDisabled)
    );
  }

  entrySatisfied(entry: ChunkSchedulerEntry): boolean {
    const demand = this.demands.get(entry.key);
    return !!demand && meshSatisfiesTarget(entry, demand.targetStep, this.lodDisabled);
  }

  private rememberDemand(candidate: ChunkCandidate, entry: ChunkSchedulerEntry | undefined) {
    const previous = this.demands.get(candidate.key);
    this.demands.set(candidate.key, {
      key: candidate.key,
      cx: candidate.cx,
      cz: candidate.cz,
      wantedAt: candidate.updatedAt,
      targetStep: candidate.targetStep,
      importance: candidate.importance,
      satisfaction: candidate.satisfaction,
      gap: candidate.gap,
      priority: { tier: candidate.tier, score: candidate.score, updatedAt: candidate.updatedAt },
      boost:
        previous?.boost &&
        (entry?.dirty || previous.boost.reason === 'dependency') &&
        candidate.updatedAt - previous.boost.updatedAt <= IO_QUEUE_RETENTION_MS
          ? previous.boost
          : null,
      meshRetryAt: previous ? previous.meshRetryAt : 0,
    });
  }

  private priorityFor(demand: Readonly<ChunkDemand>): ChunkPriority {
    return demand.boost && comparePriority(demand.boost, demand.priority) < 0 ? demand.boost : demand.priority;
  }

  private orderedKeys(queue: ReadonlySet<string>): string[] {
    return [...queue]
      .filter((key) => this.demands.has(key))
      .sort(
        (a, b) =>
          comparePriority(this.priorityFor(this.demands.get(a)!), this.priorityFor(this.demands.get(b)!)) ||
          a.localeCompare(b),
      );
  }

  private enqueue(queue: Set<string>, key: string) {
    if (!this.demands.has(key)) return;
    queue.add(key);
    if (queue.size > MAX_IO_QUEUE) {
      const keep = this.orderedKeys(queue).slice(0, MAX_IO_QUEUE);
      queue.clear();
      for (const key of keep) queue.add(key);
    }
  }

  private takeIo(queue: Set<string>, input: SchedulerWorkInput, state: 'checking' | 'hashed', limit: number): string[] {
    const out: string[] = [];
    for (const key of this.orderedKeys(queue)) {
      if (out.length >= limit) break;
      const entry = input.entries.get(key);
      if (!entry || entry.state !== state) {
        queue.delete(key);
        continue;
      }
      if ((entry.retryAt ?? 0) > input.now) continue;
      queue.delete(key);
      out.push(key);
    }
    return out;
  }

  private ioWakeAt(
    queue: ReadonlySet<string>,
    entries: ReadonlyMap<string, ChunkSchedulerEntry>,
    now: number,
  ): number | null {
    let next = Infinity;
    for (const key of queue) {
      const entry = entries.get(key);
      if (entry && (entry.retryAt ?? 0) > now) next = Math.min(next, entry.retryAt!);
    }
    return Number.isFinite(next) ? next : null;
  }

  private runnableMeshDemand(entry: ChunkSchedulerEntry, now: number): Readonly<ChunkDemand> | undefined {
    const demand = this.demands.get(entry.key);
    if (
      !demand ||
      !isDemandFresh(demand, now) ||
      demand.meshRetryAt > now ||
      entry.pendingFull ||
      entry.pendingLod ||
      (entry.retryAt ?? 0) > now ||
      (entry.state !== 'stored' && entry.state !== 'hashed') ||
      meshSatisfiesTarget(entry, demand.targetStep, this.lodDisabled)
    )
      return undefined;
    return demand;
  }

  private meshTaskCount(entries: ReadonlyMap<string, ChunkSchedulerEntry>, now: number): number {
    let count = 0;
    for (const entry of entries.values()) if (this.runnableMeshDemand(entry, now)) count++;
    return count;
  }

  private meshTasks(entries: ReadonlyMap<string, ChunkSchedulerEntry>, now: number): MeshTask[] {
    const out: MeshTask[] = [];
    for (const entry of entries.values()) {
      const demand = this.runnableMeshDemand(entry, now);
      if (!demand) continue;
      out.push({
        key: entry.key,
        kind: demand.targetStep === 1 ? 'full' : 'lod',
        step: demand.targetStep,
        ...this.priorityFor(demand),
      });
    }
    return out.sort((a, b) => compareMeshTaskPriority(a, b) || a.key.localeCompare(b.key));
  }

  private workload(entries: ReadonlyMap<string, ChunkSchedulerEntry>, backlog: number): Workload {
    let resident = 0,
      ready = 0;
    for (const entry of entries.values()) {
      if (entry.state === 'stored' || entry.state === 'decoding') resident++;
      if (entry.state === 'absent' || this.entrySatisfied(entry)) ready++;
    }
    return {
      backlog,
      resident,
      readyShare: entries.size ? ready / entries.size : 0,
    };
  }

  private prune(entries: ReadonlyMap<string, ChunkSchedulerEntry>, now: number) {
    const fresh = (key: string) => {
      const demand = this.demands.get(key);
      return (
        !!demand &&
        (isDemandFresh(demand, now) || (!!demand.boost && now - demand.boost.updatedAt <= IO_QUEUE_RETENTION_MS))
      );
    };
    for (const key of this.hashQueue) {
      const entry = entries.get(key);
      if (!fresh(key) || (entry && entry.state !== 'checking')) this.hashQueue.delete(key);
    }
    for (const key of this.fetchQueue)
      if (!fresh(key) || entries.get(key)?.state !== 'hashed') this.fetchQueue.delete(key);
    for (const [key, demand] of this.demands) {
      if (demand.boost && now - demand.boost.updatedAt > IO_QUEUE_RETENTION_MS)
        this.demands.set(key, { ...demand, boost: null });
      if (
        !entries.has(key) &&
        now - demand.wantedAt > RECORD_RETENTION_MS &&
        !this.hashQueue.has(key) &&
        !this.fetchQueue.has(key)
      )
        this.demands.delete(key);
    }
  }
}
