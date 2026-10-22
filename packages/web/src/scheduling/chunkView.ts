import type { ViewState } from '../view/state';
import { CameraGridTracker, type Pose, type RankedCell, type RankingResult } from './cameraGridTracker';
import {
  type SchedulerCellInfo,
  type ChunkCandidate,
  type CriticalCell,
  type ChunkSchedulerEntry,
  type SchedulerFramePlan,
  type SchedulerViewInput,
  type SchedulerCellDiagnostic,
  type ResolvedChunkScheduling,
} from './contracts';
import { type LodStep } from '../view/terrain';
import {
  TRACKER_CHUNK_SIZE,
  TRACKER_HISTORY_CHUNKS,
  TRACKER_SEED_SECONDS,
  CRITICAL_CENTER_RAY_MAX_CHUNKS,
  CRITICAL_CENTER_RAY_STEP_CHUNKS,
  MIN_CRITICAL_RAY_HORIZONTAL,
  CRITICAL_SCORE_BOOST,
  FULL_DETAIL_SCORE_BOOST,
  NEAR_PRESENCE_SCORE_BOOST,
  TOP_MAP_PRECISION,
  EMPTY_PRECISION,
  ACTIVE_KEEP_EPSILON,
  activeCellCapacity,
  heightForSurfaceY,
  displayedGeometryPrecision,
  trackerTimeSeconds,
  targetLodStep,
  meshCoversTarget,
  meshSatisfiesTarget,
  needsFullDowngrade,
  resolveChunkScheduling,
  comparePriority,
} from './chunkPolicy';
import { CHUNK_SIZE_BLOCKS, WORLD_MIN_Y, DEFAULT_SURFACE_Y } from '../view/worldGeometry';

function trackerConfigKey(cfg: ResolvedChunkScheduling): string {
  return [
    cfg.activeRadiusChunks,
    cfg.tauImportance,
    cfg.nearImportanceHalfLife,
    cfg.farImportanceHalfLife,
    cfg.importanceDecayDistancePower,
    cfg.tauSatisfaction,
    cfg.angleSigmaRad,
    cfg.fovRadiusRad ?? 'none',
    cfg.distanceWeightPower,
    cfg.distanceInverseSquareRadiusBlocks ?? 'none',
    cfg.overshootEta,
    cfg.neighborPrecisionEpsilon,
    cfg.neighborSatisfactionPenaltyByCount.join(','),
    cfg.minSatisfaction,
  ].join('|');
}

export class ChunkViewPlanner {
  private tracker: CameraGridTracker | null = null;
  private trackerKey = '';
  private trackerSeeded = false;
  private currentConfig = resolveChunkScheduling();
  private currentCenter = { cx: 0, cz: 0 };
  private fullDetailKeys: ReadonlySet<string> = new Set();
  get center(): Readonly<{ cx: number; cz: number }> {
    return this.currentCenter;
  }
  get config(): Readonly<ResolvedChunkScheduling> {
    return this.currentConfig;
  }
  get attentionStats() {
    return {
      cachedChunks: this.tracker ? this.tracker.chunkCount : 0,
      activeCells: this.tracker ? this.tracker.activeCount : 0,
      historyChunkLimit: TRACKER_HISTORY_CHUNKS,
    };
  }
  clear() {
    this.tracker = null;
    this.trackerKey = '';
    this.trackerSeeded = false;
    this.fullDetailKeys = new Set();
  }
  plan(input: SchedulerViewInput): SchedulerFramePlan {
    const disableLod = input.options.disableLod === true;
    const nowSeconds = trackerTimeSeconds(input.now);
    const cfg = resolveChunkScheduling(input.options.scheduling);
    this.currentConfig = cfg;
    const tracker = this.ensureTracker(cfg);

    const pose = this.poseFromView(input.view);
    const ranking = this.rankCells(tracker, pose, nowSeconds, cfg);
    const centerCx = Math.floor(input.view.position.x / CHUNK_SIZE_BLOCKS);
    const centerCz = Math.floor(input.view.position.z / CHUNK_SIZE_BLOCKS);
    this.currentCenter = { cx: centerCx, cz: centerCz };
    const fullDetailCells = this.diskCells(centerCx, centerCz, cfg.fullDetailRadiusChunks);
    const nearPresenceCells =
      cfg.nearPresenceRadiusChunks === cfg.fullDetailRadiusChunks
        ? fullDetailCells
        : this.diskCells(centerCx, centerCz, cfg.nearPresenceRadiusChunks);
    const nearPresenceKeys = new Set(nearPresenceCells.map((cell) => input.keyFor(cell.i, cell.j)));
    const nextFullDetailKeys = new Set(fullDetailCells.map((cell) => input.keyFor(cell.i, cell.j)));
    if (
      nextFullDetailKeys.size !== this.fullDetailKeys.size ||
      [...nextFullDetailKeys].some((key) => !this.fullDetailKeys.has(key))
    )
      this.fullDetailKeys = nextFullDetailKeys;
    const fullDetailKeys = this.fullDetailKeys;
    const criticalCells = this.criticalCellsForPose(pose, fullDetailCells, cfg);
    const criticalKeys = new Set(criticalCells.map((cell) => input.keyFor(cell.i, cell.j)));

    for (const cell of this.mergeRankedCells(ranking.gap.top, ranking.importance.top)) {
      this.syncTrackerCell(
        tracker,
        cell.i,
        cell.j,
        input.entries.get(input.keyFor(cell.i, cell.j)) ?? null,
        input.cellInfoFor?.(cell.i, cell.j) ?? null,
        nowSeconds,
      );
    }

    for (const cell of nearPresenceCells) {
      this.syncTrackerCell(
        tracker,
        cell.i,
        cell.j,
        input.entries.get(input.keyFor(cell.i, cell.j)) ?? null,
        input.cellInfoFor?.(cell.i, cell.j) ?? null,
        nowSeconds,
      );
    }

    const reranking = tracker.query(cfg.maxCandidates, nowSeconds, { importance: 'top', gap: 'top' });
    const criticalRankedCells = this.snapshotCriticalCells(tracker, criticalCells, nowSeconds);
    const nearPresenceRankedCells = this.snapshotCriticalCells(tracker, nearPresenceCells, nowSeconds);
    // Completed full meshes have negative gaps and normally disappear from the
    // gap ranking, which used to leave them at full detail indefinitely. Add
    // explicit downgrade candidates so they can transition to LOD as attention
    // decays, even when they are no longer in the top tracker rankings.
    const fullDowngradeCells = this.fullDowngradeCells(
      tracker,
      input.entries.values(),
      input.demands,
      nowSeconds,
      criticalKeys,
      disableLod,
    );
    const rankedCells = this.mergeRankedCells(
      criticalRankedCells,
      nearPresenceRankedCells,
      fullDowngradeCells,
      reranking.gap.top,
      reranking.importance.top,
    );
    // Admission is based on camera demand, independently of completion/gap.
    // Evicting completed cells to admit ever more unsatisfied cells makes a
    // stationary, capacity-limited view cycle forever.
    const admitted = new Set<string>();
    for (const cell of [...criticalCells, ...nearPresenceCells])
      if (input.cellInfoFor?.(cell.i, cell.j)?.hasChunkSource !== false) admitted.add(input.keyFor(cell.i, cell.j));
    const admissionOrder = rankedCells
      .map((cell) => {
        const key = input.keyFor(cell.i, cell.j);
        const entry = input.entries.get(key) ?? null;
        return { cell, key, demand: cell.importance + (entry && entry.displayed !== 'none' ? 0.02 : 0) };
      })
      .sort((a, b) => b.demand - a.demand || a.cell.i - b.cell.i || a.cell.j - b.cell.j);
    for (const { cell, key } of admissionOrder) {
      if (admitted.size >= cfg.maxTrackedChunks) break;
      if (input.cellInfoFor?.(cell.i, cell.j)?.hasChunkSource === false) continue;
      admitted.add(key);
    }
    const keepKeys = this.activeDiskKeys(pose, cfg, input.keyFor);
    const protectedKeys = new Set<string>(admitted);
    const demands: ChunkCandidate[] = [];
    const candidates: ChunkCandidate[] = [];

    for (const cell of rankedCells) {
      const key = input.keyFor(cell.i, cell.j);
      if (!admitted.has(key)) continue;
      const entry = input.entries.get(key) ?? null;
      const info = input.cellInfoFor?.(cell.i, cell.j) ?? null;
      const critical = criticalKeys.has(key);
      const fullDetail = fullDetailKeys.has(key);
      const nearPresence = nearPresenceKeys.has(key);
      keepKeys.add(key);

      const targetStep = critical
        ? 1
        : targetLodStep(cell.importance, input.demands.get(key)?.targetStep ?? 8, disableLod);
      const shouldSchedule = critical
        ? this.shouldScheduleCriticalCell(entry, info, targetStep)
        : nearPresence
          ? this.shouldScheduleNearPresenceCell(entry, info, targetStep, disableLod)
          : this.shouldScheduleCell(cell, entry, info, targetStep, cfg, disableLod);
      const candidate: ChunkCandidate = {
        key,
        cx: cell.i,
        cz: cell.j,
        targetStep,
        importance: cell.importance,
        satisfaction: cell.satisfaction,
        gap: cell.gap,
        tier: critical
          ? this.tierForCriticalCell(entry, targetStep, fullDetail)
          : nearPresence
            ? this.tierForNearPresenceCell(entry, targetStep, disableLod)
            : this.tierForCell(cell, entry, targetStep, disableLod),
        score:
          this.scoreForCell(cell, entry, targetStep, centerCx, centerCz, disableLod) +
          (fullDetail
            ? FULL_DETAIL_SCORE_BOOST
            : critical
              ? CRITICAL_SCORE_BOOST
              : nearPresence
                ? NEAR_PRESENCE_SCORE_BOOST
                : 0),
        updatedAt: input.now,
      };
      demands.push(candidate);
      if (shouldSchedule) candidates.push(candidate);
    }

    candidates.sort((a, b) => comparePriority(a, b) || a.cx - b.cx || a.cz - b.cz);
    // Preserve every nearby presence candidate even when the normal frame
    // budget is saturated; otherwise the edge of the close disk can still
    // wait for a camera turn.
    const guaranteedCandidateCount = candidates.reduce(
      (count, candidate) => count + (nearPresenceKeys.has(candidate.key) ? 1 : 0),
      0,
    );
    const frameCandidateLimit = Math.max(cfg.maxFrameCandidates, guaranteedCandidateCount);
    if (candidates.length > frameCandidateLimit) candidates.length = frameCandidateLimit;
    for (const candidate of candidates) protectedKeys.add(candidate.key);

    tracker.trimInactiveChunks(
      TRACKER_HISTORY_CHUNKS,
      (function* () {
        for (const entry of input.entries.values()) yield { i: entry.cx, j: entry.cz };
      })(),
    );
    return { demands, candidates, keepKeys, protectedKeys, fullDetailKeys, centerCx, centerCz };
  }

  private rankCells(
    tracker: CameraGridTracker,
    pose: Pose,
    nowSeconds: number,
    cfg: ResolvedChunkScheduling,
  ): RankingResult {
    if (!this.trackerSeeded) {
      const seedTime = Math.max(0, nowSeconds - TRACKER_SEED_SECONDS);
      tracker.updateCamera(seedTime, pose, 0);
      this.trackerSeeded = true;
      return tracker.advanceTime(nowSeconds, cfg.maxCandidates, { importance: 'top', gap: 'top' });
    }

    return tracker.updateCamera(nowSeconds, pose, cfg.maxCandidates, { importance: 'top', gap: 'top' });
  }

  private criticalCellsForPose(
    pose: Pose,
    fullDetailCells: readonly CriticalCell[],
    cfg: ResolvedChunkScheduling,
  ): CriticalCell[] {
    const out = [...fullDetailCells];
    const seen = new Set(out.map((cell) => `${cell.i},${cell.j}`));
    const add = (i: number, j: number): void => {
      const key = `${i},${j}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ i, j });
    };

    const horizontal = Math.cos(pose.pitch);
    const dx = horizontal * Math.sin(pose.yaw);
    const dz = horizontal * Math.cos(pose.yaw);
    const len = Math.hypot(dx, dz);
    if (len < MIN_CRITICAL_RAY_HORIZONTAL) return out;

    const ux = dx / len;
    const uz = dz / len;
    const maxChunks = Math.min(cfg.activeRadiusChunks, CRITICAL_CENTER_RAY_MAX_CHUNKS);
    for (let d = CRITICAL_CENTER_RAY_STEP_CHUNKS; d <= maxChunks; d += CRITICAL_CENTER_RAY_STEP_CHUNKS) {
      add(
        Math.floor((pose.p.x + ux * d * CHUNK_SIZE_BLOCKS) / CHUNK_SIZE_BLOCKS),
        Math.floor((pose.p.z + uz * d * CHUNK_SIZE_BLOCKS) / CHUNK_SIZE_BLOCKS),
      );
    }

    return out;
  }

  private diskCells(centerCx: number, centerCz: number, radius: number): CriticalCell[] {
    const out: CriticalCell[] = [];
    for (let di = -radius; di <= radius; di++) {
      for (let dj = -radius; dj <= radius; dj++) {
        if (di * di + dj * dj > radius * radius) continue;
        out.push({ i: centerCx + di, j: centerCz + dj });
      }
    }
    return out;
  }

  private snapshotCriticalCells(tracker: CameraGridTracker, cells: CriticalCell[], nowSeconds: number): RankedCell[] {
    return cells.map((cell) => {
      const snapshot = tracker.getCellSnapshot(cell.i, cell.j, nowSeconds);
      const gap = snapshot.importance - snapshot.satisfaction;
      return {
        i: cell.i,
        j: cell.j,
        score: gap,
        importance: snapshot.importance,
        satisfaction: snapshot.satisfaction,
        gap,
      };
    });
  }

  private fullDowngradeCells(
    tracker: CameraGridTracker,
    entries: Iterable<ChunkSchedulerEntry>,
    demands: ReadonlyMap<string, Readonly<import('./contracts').ChunkDemand>>,
    nowSeconds: number,
    forcedFull: ReadonlySet<string>,
    disableLod: boolean,
  ): RankedCell[] {
    if (disableLod) return [];

    const out: RankedCell[] = [];
    for (const entry of entries) {
      if (!demands.has(entry.key)) continue;
      if (forcedFull.has(entry.key) || entry.displayed !== 'full' || entry.dirty || entry.pendingFull) continue;
      const snapshot = tracker.getCellSnapshot(entry.cx, entry.cz, nowSeconds);
      const gap = snapshot.importance - snapshot.satisfaction;
      const cell: RankedCell = {
        i: entry.cx,
        j: entry.cz,
        score: gap,
        importance: snapshot.importance,
        satisfaction: snapshot.satisfaction,
        gap,
      };
      if (targetLodStep(cell.importance, demands.get(entry.key)!.targetStep, false) > 1) out.push(cell);
    }
    return out;
  }

  private mergeRankedCells(...groups: RankedCell[][]): RankedCell[] {
    const out: RankedCell[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const cell of group) {
        const key = `${cell.i},${cell.j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cell);
      }
    }
    return out;
  }

  private activeDiskKeys(
    pose: Pose,
    cfg: ResolvedChunkScheduling,
    keyFor: (cx: number, cz: number) => string,
  ): Set<string> {
    const out = new Set<string>();
    const radius = cfg.activeRadiusBlocks;
    const radius2 = radius * radius;
    const px = pose.p.x;
    const pz = pose.p.z;

    const i0 = Math.ceil((px - radius) / CHUNK_SIZE_BLOCKS - 0.5 - ACTIVE_KEEP_EPSILON);
    const i1 = Math.floor((px + radius) / CHUNK_SIZE_BLOCKS - 0.5 + ACTIVE_KEEP_EPSILON);

    for (let i = i0; i <= i1; i++) {
      const xc = (i + 0.5) * CHUNK_SIZE_BLOCKS;
      const dx = xc - px;
      const remain = radius2 - dx * dx;
      if (remain < -ACTIVE_KEEP_EPSILON) continue;

      const zLimit = Math.sqrt(Math.max(0, remain));
      const j0 = Math.ceil((pz - zLimit) / CHUNK_SIZE_BLOCKS - 0.5 - ACTIVE_KEEP_EPSILON);
      const j1 = Math.floor((pz + zLimit) / CHUNK_SIZE_BLOCKS - 0.5 + ACTIVE_KEEP_EPSILON);

      for (let j = j0; j <= j1; j++) out.add(keyFor(i, j));
    }

    return out;
  }

  private ensureTracker(cfg: ResolvedChunkScheduling): CameraGridTracker {
    const key = trackerConfigKey(cfg);
    if (this.tracker && this.trackerKey === key) return this.tracker;

    this.tracker = new CameraGridTracker({
      k: CHUNK_SIZE_BLOCKS,
      m: cfg.activeRadiusBlocks,
      chunkSize: TRACKER_CHUNK_SIZE,
      tauImportance: cfg.tauImportance,
      nearImportanceHalfLife: cfg.nearImportanceHalfLife,
      farImportanceHalfLife: cfg.farImportanceHalfLife,
      importanceDecayDistancePower: cfg.importanceDecayDistancePower,
      tauSatisfaction: cfg.tauSatisfaction,
      angleSigmaRad: cfg.angleSigmaRad,
      fovRadiusRad: cfg.fovRadiusRad,
      distanceWeightPower: cfg.distanceWeightPower,
      distanceInverseSquareRadius: cfg.distanceInverseSquareRadiusBlocks,
      overshootEta: cfg.overshootEta,
      maxActiveCells: activeCellCapacity(cfg.activeRadiusChunks),
      initialHeight: heightForSurfaceY(DEFAULT_SURFACE_Y),
      initialPrecision: EMPTY_PRECISION,
      precisionToSatisfaction: (precision) => precision,
      neighborPrecisionEpsilon: cfg.neighborPrecisionEpsilon,
      neighborSatisfactionPenaltyByCount: cfg.neighborSatisfactionPenaltyByCount,
      minSatisfaction: cfg.minSatisfaction,
    });
    this.trackerKey = key;
    this.trackerSeeded = false;
    return this.tracker;
  }

  private poseFromView(view: ViewState): Pose {
    const length = Math.hypot(view.direction.x, view.direction.y, view.direction.z);
    if (!(length > 0)) throw new RangeError('view direction must be nonzero');
    const x = view.direction.x / length;
    const y = view.direction.y / length;
    const z = view.direction.z / length;
    return {
      p: { x: view.position.x, y: view.position.y - WORLD_MIN_Y, z: view.position.z },
      yaw: Math.atan2(x, z),
      pitch: Math.asin(Math.max(-1, Math.min(1, y))),
    };
  }

  private syncTrackerCell(
    tracker: CameraGridTracker,
    i: number,
    j: number,
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    nowSeconds: number,
  ) {
    tracker.setHeight(i, j, this.heightForCell(entry, info), nowSeconds);
    tracker.setPrecision(i, j, this.precisionForCell(entry, info), nowSeconds);
  }

  syncEntry(entry: ChunkSchedulerEntry, nowSeconds: number) {
    if (!this.tracker) return;
    this.tracker.setHeight(entry.cx, entry.cz, this.heightForCell(entry, null), nowSeconds);
    this.tracker.setPrecision(entry.cx, entry.cz, this.precisionForCell(entry, null), nowSeconds);
  }

  private heightForCell(entry: ChunkSchedulerEntry | null, info: SchedulerCellInfo | null): number {
    const entrySurfaceY = entry?.surfaceY;
    if (Number.isFinite(entrySurfaceY)) return heightForSurfaceY(entrySurfaceY!);
    if (Number.isFinite(info?.topMapSurfaceY)) return heightForSurfaceY(info!.topMapSurfaceY!);
    return heightForSurfaceY(DEFAULT_SURFACE_Y);
  }

  private precisionForCell(entry: ChunkSchedulerEntry | null, info: SchedulerCellInfo | null): number {
    if (info?.hasChunkSource === false) return 1;
    if (!entry) return Number.isFinite(info?.topMapSurfaceY) ? TOP_MAP_PRECISION : EMPTY_PRECISION;
    if (entry.state === 'absent') {
      return 1;
    }
    if (entry.state === 'error') return 0;
    if (entry.displayed !== 'none') return displayedGeometryPrecision(entry);
    if (entry.dirty) return 0;
    return Number.isFinite(info?.topMapSurfaceY) ? TOP_MAP_PRECISION : EMPTY_PRECISION;
  }

  private shouldScheduleCell(
    cell: RankedCell,
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    targetStep: LodStep,
    cfg: ResolvedChunkScheduling,
    disableLod: boolean,
  ): boolean {
    if (info?.hasChunkSource === false) return false;
    if (entry?.state === 'absent' || entry?.state === 'error') return false;
    if (entry && (!meshCoversTarget(entry, targetStep) || needsFullDowngrade(entry, targetStep, disableLod)))
      return true;
    if (!entry) {
      return cell.importance >= cfg.minImportanceToSchedule || cell.gap >= cfg.minGapToSchedule;
    }
    return entry.dirty || cell.gap >= cfg.minGapToSchedule;
  }

  private shouldScheduleCriticalCell(
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    targetStep: LodStep,
  ): boolean {
    if (info?.hasChunkSource === false) return false;
    if (entry?.state === 'absent' || entry?.state === 'error') return false;
    if (!entry) return true;
    return entry.dirty || !meshCoversTarget(entry, targetStep);
  }

  private shouldScheduleNearPresenceCell(
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    targetStep: LodStep,
    disableLod: boolean,
  ): boolean {
    if (info?.hasChunkSource === false) return false;
    if (entry?.state === 'absent' || entry?.state === 'error') return false;
    if (!entry) return true;
    return !meshSatisfiesTarget(entry, targetStep, disableLod);
  }

  private tierForCell(
    cell: RankedCell,
    entry: ChunkSchedulerEntry | null,
    targetStep: LodStep,
    disableLod: boolean,
  ): number {
    if (entry?.state === 'stored' && !meshCoversTarget(entry, targetStep)) return 0;
    // Let a stale full -> LOD replacement run before ordinary background work;
    // otherwise an old full mesh can monopolize memory while it waits behind
    // newly discovered distant chunks.
    if (entry?.state === 'stored' && needsFullDowngrade(entry, targetStep, disableLod)) return 1;
    if (entry?.dirty) return entry.displayed === 'none' ? 1 : 4;
    if (!entry) return 2;
    if (
      entry.state === 'checking' ||
      entry.state === 'resolving' ||
      entry.state === 'hashed' ||
      entry.state === 'fetching'
    )
      return 2;
    if (targetStep === 1 && entry.displayed !== 'full') return 1;
    if (cell.gap > 0.2) return 4;
    return 5;
  }

  private tierForCriticalCell(entry: ChunkSchedulerEntry | null, targetStep: LodStep, near: boolean): number {
    const boost = near ? -2 : 0;
    if (entry?.dirty) return meshCoversTarget(entry, targetStep) ? 1 + boost : -3 + boost;
    if (entry?.state === 'stored' && !meshCoversTarget(entry, targetStep)) return -3 + boost;
    if (!entry) return -2 + boost;
    if (
      entry.state === 'checking' ||
      entry.state === 'resolving' ||
      entry.state === 'hashed' ||
      entry.state === 'fetching'
    )
      return -2 + boost;
    if (!meshCoversTarget(entry, targetStep)) return -1 + boost;
    return 0;
  }

  private tierForNearPresenceCell(entry: ChunkSchedulerEntry | null, targetStep: LodStep, disableLod: boolean): number {
    if (!entry) return -1;
    if (
      entry.state === 'checking' ||
      entry.state === 'resolving' ||
      entry.state === 'hashed' ||
      entry.state === 'fetching'
    )
      return -1;
    if (entry.state === 'stored' && !meshSatisfiesTarget(entry, targetStep, disableLod)) {
      return entry.displayed === 'none' ? -1 : 2;
    }
    return 3;
  }

  private scoreForCell(
    cell: RankedCell,
    entry: ChunkSchedulerEntry | null,
    targetStep: LodStep,
    centerCx: number,
    centerCz: number,
    disableLod: boolean,
  ): number {
    const distance = Math.hypot(cell.i + 0.5 - (centerCx + 0.5), cell.j + 0.5 - (centerCz + 0.5));
    const renderBoost = entry?.state === 'stored' && !meshSatisfiesTarget(entry, targetStep, disableLod) ? -300 : 0;
    const ioPenalty =
      !entry ||
      entry.state === 'checking' ||
      entry.state === 'resolving' ||
      entry.state === 'hashed' ||
      entry.state === 'fetching'
        ? 120
        : 0;
    return renderBoost + ioPenalty - cell.gap * 1200 - cell.importance * 320 + distance * 0.7;
  }

  diagnosticCell(cx: number, cz: number): SchedulerCellDiagnostic | null {
    const tracker = this.tracker;
    if (!tracker) return null;
    // Do not advance the tracker here: diagnostics must not change the camera
    // integration interval that the next scheduler tick will consume.
    const snapshot = tracker.getCellSnapshot(cx, cz, tracker.currentTime);
    return {
      cx,
      cz,
      height: snapshot.height,
      precision: snapshot.precision,
      importance: snapshot.importance,
      satisfaction: snapshot.satisfaction,
      gap: snapshot.importance - snapshot.satisfaction,
      bump: snapshot.bump,
    };
  }
}
