/**
 * CameraGridTracker
 *
 * Pure TypeScript implementation for tracking importance/satisfaction over an
 * infinite x-z grid of vertical columns around a moving camera.
 *
 * Runtime-neutral: no DOM, no Worker API, no Node-specific API.
 * Works in browsers, Web Workers, Node.js, Deno, Bun, etc.
 *
 * Coordinate convention:
 * - Grid lies on x-z plane.
 * - Column (i, j) has center ((i + 0.5) * k, (j + 0.5) * k).
 * - Column vertical segment is y in [0, height].
 * - yaw = 0 faces +z.
 * - positive yaw rotates toward +x.
 * - positive pitch looks upward.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Pose {
  p: Vec3;
  yaw: number;
  pitch: number;
}

export interface RankedCell {
  i: number;
  j: number;
  score: number;
  importance: number;
  satisfaction: number;
  gap: number;
}

export interface RankingPair {
  top: RankedCell[];
  bottom: RankedCell[];
}

export interface RankingResult {
  time: number;
  activeCount: number;
  importance: RankingPair;
  satisfaction: RankingPair;
  gap: RankingPair;
}

export interface CellSnapshot {
  i: number;
  j: number;
  height: number;
  precision: number;
  importance: number;
  satisfaction: number;
  bump: number;
  tImportance: number;
  tBump: number;
}

export interface TrackerConfig {
  /** Grid cell side length. */
  k: number;

  /** Horizontal Euclidean radius on the x-z plane. */
  m: number;

  /** Chunk side length in cells. 32 is a good default. */
  chunkSize?: number;

  /** Time constant for importance response/decay. */
  tauImportance?: number;

  /** Time constant for satisfaction overshoot decay. */
  tauSatisfaction?: number;

  /** Gaussian angular falloff sigma, in radians. */
  angleSigmaRad?: number;

  /** Optional hard field-of-view radius, in radians. null means no hard cutoff. */
  fovRadiusRad?: number | null;

  /** Distance falloff exponent. 1 means linear distance falloff. */
  distanceWeightPower?: number;

  /** Added overshoot = overshootEta * positive base-satisfaction increase. */
  overshootEta?: number;

  /** Satisfaction clamp lower bound. */
  minSatisfaction?: number;

  /** Satisfaction clamp upper bound. */
  maxSatisfaction?: number;

  /** Guardrail against accidentally enumerating an enormous disk. */
  maxActiveCells?: number;

  /** Initial cell height, or a function of grid coordinate. */
  initialHeight?: number | ((i: number, j: number) => number);

  /** Initial precision, or a function of grid coordinate. */
  initialPrecision?: number | ((i: number, j: number) => number);

  /** Initial importance, or a function of grid coordinate. Usually 0. */
  initialImportance?: number | ((i: number, j: number) => number);

  /** Initial satisfaction overshoot bump, or a function of grid coordinate. Usually 0. */
  initialBump?: number | ((i: number, j: number) => number);

  /** Maps precision to baseline satisfaction before transient bump. */
  precisionToSatisfaction?: (precision: number) => number;

  /** Optional custom angle weight. Receives theta in radians and best cosine. */
  angleWeight?: (theta: number, bestCos: number) => number;

  /** Optional custom horizontal distance weight. */
  distanceWeight?: (horizontalDistance: number, m: number) => number;

  /** Small epsilon for numeric boundary checks. */
  epsilon?: number;
}

interface ResolvedConfig {
  k: number;
  m: number;
  chunkSize: number;
  tauImportance: number;
  tauSatisfaction: number;
  angleSigmaRad: number;
  fovRadiusRad: number | null;
  distanceWeightPower: number;
  overshootEta: number;
  minSatisfaction: number;
  maxSatisfaction: number;
  maxActiveCells: number;
  initialHeight: (i: number, j: number) => number;
  initialPrecision: (i: number, j: number) => number;
  initialImportance: (i: number, j: number) => number;
  initialBump: (i: number, j: number) => number;
  precisionToSatisfaction: (precision: number) => number;
  angleWeight?: (theta: number, bestCos: number) => number;
  distanceWeight?: (horizontalDistance: number, m: number) => number;
  epsilon: number;
}

class Chunk {
  readonly count: number;

  readonly height: Float32Array;
  readonly precision: Float32Array;

  readonly importance: Float64Array;
  readonly tImportance: Float64Array;

  readonly bump: Float64Array;
  readonly tBump: Float64Array;

  readonly initialized: Uint8Array;

  constructor(readonly size: number) {
    this.count = size * size;

    this.height = new Float32Array(this.count);
    this.precision = new Float32Array(this.count);

    this.importance = new Float64Array(this.count);
    this.tImportance = new Float64Array(this.count);

    this.bump = new Float64Array(this.count);
    this.tBump = new Float64Array(this.count);

    this.initialized = new Uint8Array(this.count);
  }
}

class SparseChunkGrid {
  readonly chunks = new Map<string, Chunk>();

  constructor(private readonly cfg: ResolvedConfig) {}

  get chunkCount(): number {
    return this.chunks.size;
  }

  getOrCreateChunk(ci: number, cj: number): Chunk {
    const key = `${ci},${cj}`;
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = new Chunk(this.cfg.chunkSize);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  getChunkIfExists(ci: number, cj: number): Chunk | undefined {
    return this.chunks.get(`${ci},${cj}`);
  }

  cellLocation(i: number, j: number): { ci: number; cj: number; li: number; lj: number; index: number } {
    assertSafeInteger(i, "cell i");
    assertSafeInteger(j, "cell j");

    const s = this.cfg.chunkSize;
    const ci = Math.floor(i / s);
    const cj = Math.floor(j / s);
    const li = i - ci * s;
    const lj = j - cj * s;
    const index = li * s + lj;

    return { ci, cj, li, lj, index };
  }

  initCellIfNeeded(chunk: Chunk, index: number, i: number, j: number, now: number): void {
    if (chunk.initialized[index] !== 0) return;

    const height = this.cfg.initialHeight(i, j);
    const precision = this.cfg.initialPrecision(i, j);
    const importance = this.cfg.initialImportance(i, j);
    const bump = this.cfg.initialBump(i, j);

    assertFiniteNumber(height, "initialHeight");
    assertFiniteNumber(precision, "initialPrecision");
    assertFiniteNumber(importance, "initialImportance");
    assertFiniteNumber(bump, "initialBump");
    if (height < 0) throw new RangeError(`initialHeight must be >= 0, got ${height}`);

    chunk.height[index] = height;
    chunk.precision[index] = precision;
    chunk.importance[index] = importance;
    chunk.tImportance[index] = now;
    chunk.bump[index] = bump;
    chunk.tBump[index] = now;
    chunk.initialized[index] = 1;
  }

  getOrCreateCell(i: number, j: number, now: number): { chunk: Chunk; index: number } {
    const loc = this.cellLocation(i, j);
    const chunk = this.getOrCreateChunk(loc.ci, loc.cj);
    this.initCellIfNeeded(chunk, loc.index, i, j, now);
    return { chunk, index: loc.index };
  }
}

class ActiveSet {
  length = 0;

  i: Float64Array;
  j: Float64Array;
  index: Uint32Array;
  chunks: Chunk[];

  constructor(initialCapacity = 1024) {
    const cap = Math.max(1, initialCapacity | 0);
    this.i = new Float64Array(cap);
    this.j = new Float64Array(cap);
    this.index = new Uint32Array(cap);
    this.chunks = new Array<Chunk>(cap);
  }

  clear(): void {
    this.length = 0;
  }

  ensureCapacity(required: number): void {
    if (required <= this.i.length) return;

    let cap = this.i.length;
    while (cap < required) cap *= 2;

    const ni = new Float64Array(cap);
    ni.set(this.i);
    this.i = ni;

    const nj = new Float64Array(cap);
    nj.set(this.j);
    this.j = nj;

    const nIndex = new Uint32Array(cap);
    nIndex.set(this.index);
    this.index = nIndex;

    this.chunks.length = cap;
  }

  push(i: number, j: number, chunk: Chunk, index: number): void {
    const pos = this.length;
    this.ensureCapacity(pos + 1);
    this.i[pos] = i;
    this.j[pos] = j;
    this.chunks[pos] = chunk;
    this.index[pos] = index;
    this.length = pos + 1;
  }
}

class BoundedRankHeap {
  private readonly heap: RankedCell[] = [];

  constructor(private readonly n: number, private readonly mode: "largest" | "smallest") {}

  offer(
    i: number,
    j: number,
    score: number,
    importance: number,
    satisfaction: number,
    gap: number,
  ): void {
    if (this.n <= 0) return;
    if (!Number.isFinite(score)) return;

    const root = this.heap[0];

    if (this.heap.length < this.n) {
      this.heap.push({ i, j, score, importance, satisfaction, gap });
      this.siftUp(this.heap.length - 1);
      return;
    }

    if (root === undefined || !this.isBetterThanRoot(score)) return;

    // Reuse root object to reduce allocations.
    root.i = i;
    root.j = j;
    root.score = score;
    root.importance = importance;
    root.satisfaction = satisfaction;
    root.gap = gap;
    this.siftDown(0);
  }

  toSortedArray(): RankedCell[] {
    const out = this.heap.map((x) => ({ ...x }));
    if (this.mode === "largest") {
      out.sort((a, b) => sortRankDesc(a, b));
    } else {
      out.sort((a, b) => sortRankAsc(a, b));
    }
    return out;
  }

  private isBetterThanRoot(score: number): boolean {
    const root = this.heap[0];
    if (root === undefined) return true;
    return this.mode === "largest" ? score > root.score : score < root.score;
  }

  /** True if a should be nearer the heap root than b. Root is the worst kept item. */
  private rootOrderedBefore(a: RankedCell, b: RankedCell): boolean {
    if (this.mode === "largest") {
      // For keeping largest values, root is the smallest score.
      return a.score < b.score;
    }
    // For keeping smallest values, root is the largest score.
    return a.score > b.score;
  }

  private siftUp(pos: number): void {
    const h = this.heap;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (!this.rootOrderedBefore(h[pos], h[parent])) break;
      swap(h, pos, parent);
      pos = parent;
    }
  }

  private siftDown(pos: number): void {
    const h = this.heap;
    const len = h.length;

    while (true) {
      let best = pos;
      const l = pos * 2 + 1;
      const r = l + 1;

      if (l < len && this.rootOrderedBefore(h[l], h[best])) best = l;
      if (r < len && this.rootOrderedBefore(h[r], h[best])) best = r;
      if (best === pos) break;

      swap(h, pos, best);
      pos = best;
    }
  }
}

export class CameraGridTracker {
  private readonly cfg: ResolvedConfig;
  private readonly grid: SparseChunkGrid;

  private active = new ActiveSet();
  private scratch = new ActiveSet();

  private lastPose: Pose | null = null;
  private lastT = 0;

  constructor(config: TrackerConfig) {
    this.cfg = resolveConfig(config);
    this.grid = new SparseChunkGrid(this.cfg);
  }

  get activeCount(): number {
    return this.active.length;
  }

  get chunkCount(): number {
    return this.grid.chunkCount;
  }

  get currentTime(): number {
    return this.lastT;
  }

  get currentPose(): Pose | null {
    return this.lastPose === null ? null : clonePose(this.lastPose);
  }

  /**
   * Main camera update.
   *
   * The interval [previous_t, t) is integrated using the previous pose.
   * Then the active disk is rebuilt around the new pose.
   * Returned rankings describe the disk around the new pose at exactly time t.
   */
  updateCamera(t: number, pose: Pose, n = 0): RankingResult {
    assertFiniteNumber(t, "t");
    validatePose(pose);
    assertNonNegativeInteger(n, "n");

    if (this.lastPose !== null && t < this.lastT - this.cfg.epsilon) {
      throw new RangeError(`camera time must be non-decreasing: got ${t}, previous ${this.lastT}`);
    }

    if (this.lastPose !== null && t > this.lastT) {
      this.applyCameraInterval(this.active, this.lastT, t, this.lastPose);
    }

    this.buildDisk(this.scratch, pose.p.x, pose.p.z, t);

    const result = this.queryActiveSet(this.scratch, t, n);

    const oldActive = this.active;
    this.active = this.scratch;
    this.scratch = oldActive;
    this.scratch.clear();

    this.lastPose = clonePose(pose);
    this.lastT = t;

    return result;
  }

  /**
   * Advance time without changing camera pose. Useful if queries happen between
   * camera samples and the current pose should keep contributing importance.
   */
  advanceTime(t: number, n = 0): RankingResult {
    assertFiniteNumber(t, "t");
    assertNonNegativeInteger(n, "n");

    if (this.lastPose === null) {
      throw new Error("advanceTime() requires at least one updateCamera() call first");
    }
    if (t < this.lastT - this.cfg.epsilon) {
      throw new RangeError(`time must be non-decreasing: got ${t}, previous ${this.lastT}`);
    }

    if (t > this.lastT) {
      this.applyCameraInterval(this.active, this.lastT, t, this.lastPose);
      this.lastT = t;
    }

    return this.queryActiveSet(this.active, t, n);
  }

  /** Query rankings over the current active disk without adding more viewing time. */
  query(n: number, t = this.lastT): RankingResult {
    assertFiniteNumber(t, "t");
    assertNonNegativeInteger(n, "n");
    return this.queryActiveSet(this.active, t, n);
  }

  setHeight(i: number, j: number, height: number, t = this.lastT): void {
    assertSafeInteger(i, "cell i");
    assertSafeInteger(j, "cell j");
    assertFiniteNumber(height, "height");
    assertFiniteNumber(t, "t");
    if (height < 0) throw new RangeError(`height must be >= 0, got ${height}`);

    const { chunk, index } = this.grid.getOrCreateCell(i, j, t);
    chunk.height[index] = height;
  }

  getHeight(i: number, j: number, t = this.lastT): number {
    assertSafeInteger(i, "cell i");
    assertSafeInteger(j, "cell j");
    assertFiniteNumber(t, "t");

    const { chunk, index } = this.grid.getOrCreateCell(i, j, t);
    return chunk.height[index];
  }

  /**
   * External precision update.
   * If baseline satisfaction increases, an overshoot bump is added and then
   * decays back to the baseline over tauSatisfaction.
   */
  setPrecision(i: number, j: number, precision: number, t = this.lastT): void {
    assertSafeInteger(i, "cell i");
    assertSafeInteger(j, "cell j");
    assertFiniteNumber(precision, "precision");
    assertFiniteNumber(t, "t");

    const { chunk, index } = this.grid.getOrCreateCell(i, j, t);

    const oldBase = this.clampSatisfaction(this.cfg.precisionToSatisfaction(chunk.precision[index]));
    const newBase = this.clampSatisfaction(this.cfg.precisionToSatisfaction(precision));

    this.realizeBumpInPlace(chunk, index, t);

    if (newBase > oldBase) {
      chunk.bump[index] += this.cfg.overshootEta * (newBase - oldBase);
    }

    chunk.precision[index] = precision;
  }

  getPrecision(i: number, j: number, t = this.lastT): number {
    assertSafeInteger(i, "cell i");
    assertSafeInteger(j, "cell j");
    assertFiniteNumber(t, "t");

    const { chunk, index } = this.grid.getOrCreateCell(i, j, t);
    return chunk.precision[index];
  }

  getCellSnapshot(i: number, j: number, t = this.lastT): CellSnapshot {
    assertSafeInteger(i, "cell i");
    assertSafeInteger(j, "cell j");
    assertFiniteNumber(t, "t");

    const { chunk, index } = this.grid.getOrCreateCell(i, j, t);
    const importance = this.realizeImportanceInPlace(chunk, index, t);
    const satisfaction = this.satisfaction(chunk, index, t);

    return {
      i,
      j,
      height: chunk.height[index],
      precision: chunk.precision[index],
      importance,
      satisfaction,
      bump: chunk.bump[index],
      tImportance: chunk.tImportance[index],
      tBump: chunk.tBump[index],
    };
  }

  /** Optional memory maintenance. Deletes chunks for which every cell passes predicate. */
  deleteChunksWhere(predicate: (chunk: unknown) => boolean): number {
    let removed = 0;
    for (const [key, chunk] of this.grid.chunks) {
      if (predicate(chunk)) {
        this.grid.chunks.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private buildDisk(out: ActiveSet, px: number, pz: number, now: number): void {
    out.clear();

    const { k, m, chunkSize, maxActiveCells, epsilon } = this.cfg;
    const m2 = m * m;

    const i0 = Math.ceil((px - m) / k - 0.5 - epsilon);
    const i1 = Math.floor((px + m) / k - 0.5 + epsilon);

    assertSafeInteger(i0, "disk i0");
    assertSafeInteger(i1, "disk i1");

    for (let i = i0; i <= i1; i++) {
      const xc = (i + 0.5) * k;
      const dx = xc - px;
      const remain = m2 - dx * dx;

      if (remain < -epsilon) continue;

      const zLim = Math.sqrt(Math.max(0, remain));
      const j0 = Math.ceil((pz - zLim) / k - 0.5 - epsilon);
      const j1 = Math.floor((pz + zLim) / k - 0.5 + epsilon);

      assertSafeInteger(j0, "disk j0");
      assertSafeInteger(j1, "disk j1");

      for (let j = j0; j <= j1; j++) {
        if (out.length >= maxActiveCells) {
          throw new RangeError(
            `active disk exceeded maxActiveCells=${maxActiveCells}; reduce m/k or raise maxActiveCells`,
          );
        }

        const ci = Math.floor(i / chunkSize);
        const cj = Math.floor(j / chunkSize);
        const li = i - ci * chunkSize;
        const lj = j - cj * chunkSize;
        const index = li * chunkSize + lj;

        const chunk = this.grid.getOrCreateChunk(ci, cj);
        this.grid.initCellIfNeeded(chunk, index, i, j, now);
        out.push(i, j, chunk, index);
      }
    }
  }

  private applyCameraInterval(active: ActiveSet, fromT: number, toT: number, pose: Pose): void {
    const dt = toT - fromT;
    if (dt <= 0) return;

    const a = Math.exp(-dt / this.cfg.tauImportance);
    const oneMinusA = 1 - a;

    for (let pos = 0; pos < active.length; pos++) {
      const chunk = active.chunks[pos];
      const index = active.index[pos];

      const i = active.i[pos];
      const j = active.j[pos];

      const oldImportance = this.realizeImportanceInPlace(chunk, index, fromT);
      const w = this.gazeWeight(i, j, chunk, index, pose);

      chunk.importance[index] = oldImportance * a + w * oneMinusA;
      chunk.tImportance[index] = toT;
    }
  }

  private queryActiveSet(active: ActiveSet, t: number, n: number): RankingResult {
    const topImportance = new BoundedRankHeap(n, "largest");
    const bottomImportance = new BoundedRankHeap(n, "smallest");
    const topSatisfaction = new BoundedRankHeap(n, "largest");
    const bottomSatisfaction = new BoundedRankHeap(n, "smallest");
    const topGap = new BoundedRankHeap(n, "largest");
    const bottomGap = new BoundedRankHeap(n, "smallest");

    for (let pos = 0; pos < active.length; pos++) {
      const chunk = active.chunks[pos];
      const index = active.index[pos];
      const i = active.i[pos];
      const j = active.j[pos];

      const importance = this.realizeImportanceInPlace(chunk, index, t);
      const satisfaction = this.satisfaction(chunk, index, t);
      const gap = importance - satisfaction;

      topImportance.offer(i, j, importance, importance, satisfaction, gap);
      bottomImportance.offer(i, j, importance, importance, satisfaction, gap);

      topSatisfaction.offer(i, j, satisfaction, importance, satisfaction, gap);
      bottomSatisfaction.offer(i, j, satisfaction, importance, satisfaction, gap);

      topGap.offer(i, j, gap, importance, satisfaction, gap);
      bottomGap.offer(i, j, gap, importance, satisfaction, gap);
    }

    return {
      time: t,
      activeCount: active.length,
      importance: {
        top: topImportance.toSortedArray(),
        bottom: bottomImportance.toSortedArray(),
      },
      satisfaction: {
        top: topSatisfaction.toSortedArray(),
        bottom: bottomSatisfaction.toSortedArray(),
      },
      gap: {
        top: topGap.toSortedArray(),
        bottom: bottomGap.toSortedArray(),
      },
    };
  }

  private realizeImportanceInPlace(chunk: Chunk, index: number, t: number): number {
    const dt = t - chunk.tImportance[index];
    if (dt > 0) {
      chunk.importance[index] *= Math.exp(-dt / this.cfg.tauImportance);
      chunk.tImportance[index] = t;
    }
    return chunk.importance[index];
  }

  private realizeBumpInPlace(chunk: Chunk, index: number, t: number): number {
    const dt = t - chunk.tBump[index];
    if (dt > 0) {
      chunk.bump[index] *= Math.exp(-dt / this.cfg.tauSatisfaction);
      chunk.tBump[index] = t;
    }
    return chunk.bump[index];
  }

  private satisfaction(chunk: Chunk, index: number, t: number): number {
    const base = this.clampSatisfaction(this.cfg.precisionToSatisfaction(chunk.precision[index]));
    const dt = t - chunk.tBump[index];
    const transient = dt > 0
      ? chunk.bump[index] * Math.exp(-dt / this.cfg.tauSatisfaction)
      : chunk.bump[index];

    return this.clampSatisfaction(base + transient);
  }

  private clampSatisfaction(x: number): number {
    assertFiniteNumber(x, "satisfaction");
    return Math.max(this.cfg.minSatisfaction, Math.min(this.cfg.maxSatisfaction, x));
  }

  private gazeWeight(i: number, j: number, chunk: Chunk, index: number, pose: Pose): number {
    const { k, m, epsilon } = this.cfg;

    const px = pose.p.x;
    const py = pose.p.y;
    const pz = pose.p.z;

    const xc = (i + 0.5) * k;
    const zc = (j + 0.5) * k;

    const qx = xc - px;
    const qz = zc - pz;
    const horizontal2 = qx * qx + qz * qz;
    const horizontal = Math.sqrt(horizontal2);

    if (horizontal > m + epsilon) return 0;

    const cp = Math.cos(pose.pitch);
    const dx = cp * Math.sin(pose.yaw);
    const dy = Math.sin(pose.pitch);
    const dz = cp * Math.cos(pose.yaw);

    const h = chunk.height[index];
    const g = dx * qx + dz * qz;

    let bestCos = -Infinity;

    const testDelta = (delta: number): void => {
      const len = Math.sqrt(horizontal2 + delta * delta);
      if (len <= epsilon) return;
      const c = (g + dy * delta) / len;
      if (c > bestCos) bestCos = c;
    };

    // Bottom and top of the vertical column segment.
    testDelta(-py);
    testDelta(h - py);

    // Interior extremum of cos(theta) along y, if it lies on the segment.
    if (Math.abs(g) > epsilon) {
      const deltaStar = (dy * horizontal2) / g;
      const yStar = py + deltaStar;
      if (yStar >= -epsilon && yStar <= h + epsilon) {
        testDelta(deltaStar);
      }
    }

    if (!(bestCos > 0)) return 0;

    bestCos = Math.max(-1, Math.min(1, bestCos));
    const theta = Math.acos(bestCos);

    const angleWeight = this.cfg.angleWeight !== undefined
      ? this.cfg.angleWeight(theta, bestCos)
      : defaultAngleWeight(theta, bestCos, this.cfg);

    if (!(angleWeight > 0)) return 0;

    const distanceWeight = this.cfg.distanceWeight !== undefined
      ? this.cfg.distanceWeight(horizontal, m)
      : defaultDistanceWeight(horizontal, this.cfg);

    if (!(distanceWeight > 0)) return 0;

    const w = angleWeight * distanceWeight;
    return Number.isFinite(w) ? Math.max(0, w) : 0;
  }
}

function resolveConfig(config: TrackerConfig): ResolvedConfig {
  assertFiniteNumber(config.k, "k");
  assertFiniteNumber(config.m, "m");
  if (config.k <= 0) throw new RangeError(`k must be > 0, got ${config.k}`);
  if (config.m <= 0) throw new RangeError(`m must be > 0, got ${config.m}`);

  const chunkSize = config.chunkSize ?? 32;
  assertPositiveInteger(chunkSize, "chunkSize");
  if (chunkSize > 4096) throw new RangeError(`chunkSize is suspiciously large: ${chunkSize}`);

  const tauImportance = config.tauImportance ?? 1.0;
  const tauSatisfaction = config.tauSatisfaction ?? 3.0;
  const angleSigmaRad = config.angleSigmaRad ?? 0.25;
  const fovRadiusRad = config.fovRadiusRad === undefined ? null : config.fovRadiusRad;
  const distanceWeightPower = config.distanceWeightPower ?? 1.0;
  const overshootEta = config.overshootEta ?? 0.15;
  const minSatisfaction = config.minSatisfaction ?? 0;
  const maxSatisfaction = config.maxSatisfaction ?? 1;
  const maxActiveCells = config.maxActiveCells ?? Number.POSITIVE_INFINITY;
  const epsilon = config.epsilon ?? 1e-9;

  assertFiniteNumber(tauImportance, "tauImportance");
  assertFiniteNumber(tauSatisfaction, "tauSatisfaction");
  assertFiniteNumber(angleSigmaRad, "angleSigmaRad");
  assertFiniteNumber(distanceWeightPower, "distanceWeightPower");
  assertFiniteNumber(overshootEta, "overshootEta");
  assertFiniteNumber(minSatisfaction, "minSatisfaction");
  assertFiniteNumber(maxSatisfaction, "maxSatisfaction");
  assertFiniteNumber(maxActiveCells, "maxActiveCells");
  assertFiniteNumber(epsilon, "epsilon");

  if (tauImportance <= 0) throw new RangeError("tauImportance must be > 0");
  if (tauSatisfaction <= 0) throw new RangeError("tauSatisfaction must be > 0");
  if (angleSigmaRad <= 0) throw new RangeError("angleSigmaRad must be > 0");
  if (distanceWeightPower <= 0) throw new RangeError("distanceWeightPower must be > 0");
  if (maxSatisfaction < minSatisfaction) {
    throw new RangeError("maxSatisfaction must be >= minSatisfaction");
  }
  if (maxActiveCells < 0) throw new RangeError("maxActiveCells must be >= 0");
  if (epsilon <= 0) throw new RangeError("epsilon must be > 0");
  if (fovRadiusRad !== null) {
    assertFiniteNumber(fovRadiusRad, "fovRadiusRad");
    if (fovRadiusRad <= 0) throw new RangeError("fovRadiusRad must be > 0 or null");
  }

  return {
    k: config.k,
    m: config.m,
    chunkSize,
    tauImportance,
    tauSatisfaction,
    angleSigmaRad,
    fovRadiusRad,
    distanceWeightPower,
    overshootEta,
    minSatisfaction,
    maxSatisfaction,
    maxActiveCells,
    initialHeight: scalarOrFn(config.initialHeight ?? 1),
    initialPrecision: scalarOrFn(config.initialPrecision ?? 0),
    initialImportance: scalarOrFn(config.initialImportance ?? 0),
    initialBump: scalarOrFn(config.initialBump ?? 0),
    precisionToSatisfaction: config.precisionToSatisfaction ?? ((p: number) => p),
    angleWeight: config.angleWeight,
    distanceWeight: config.distanceWeight,
    epsilon,
  };
}

function defaultAngleWeight(theta: number, _bestCos: number, cfg: ResolvedConfig): number {
  if (cfg.fovRadiusRad !== null && theta > cfg.fovRadiusRad) return 0;
  const x = theta / cfg.angleSigmaRad;
  return Math.exp(-(x * x));
}

function defaultDistanceWeight(horizontal: number, cfg: ResolvedConfig): number {
  const base = Math.max(0, Math.min(1, 1 - horizontal / cfg.m));
  if (cfg.distanceWeightPower === 1) return base;
  return Math.pow(base, cfg.distanceWeightPower);
}

function scalarOrFn(value: number | ((i: number, j: number) => number)): (i: number, j: number) => number {
  return typeof value === "function" ? value : () => value;
}

function validatePose(pose: Pose): void {
  assertFiniteNumber(pose.p.x, "pose.p.x");
  assertFiniteNumber(pose.p.y, "pose.p.y");
  assertFiniteNumber(pose.p.z, "pose.p.z");
  assertFiniteNumber(pose.yaw, "pose.yaw");
  assertFiniteNumber(pose.pitch, "pose.pitch");
}

function clonePose(pose: Pose): Pose {
  return {
    p: { x: pose.p.x, y: pose.p.y, z: pose.p.z },
    yaw: pose.yaw,
    pitch: pose.pitch,
  };
}

function assertFiniteNumber(x: number, name: string): void {
  if (!Number.isFinite(x)) throw new TypeError(`${name} must be finite, got ${x}`);
}

function assertSafeInteger(x: number, name: string): void {
  if (!Number.isSafeInteger(x)) throw new TypeError(`${name} must be a safe integer, got ${x}`);
}

function assertPositiveInteger(x: number, name: string): void {
  if (!Number.isInteger(x) || x <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${x}`);
  }
}

function assertNonNegativeInteger(x: number, name: string): void {
  if (!Number.isInteger(x) || x < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${x}`);
  }
}

function swap<T>(a: T[], i: number, j: number): void {
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
}

function sortRankDesc(a: RankedCell, b: RankedCell): number {
  const ds = b.score - a.score;
  if (ds !== 0) return ds;
  if (a.i !== b.i) return a.i - b.i;
  return a.j - b.j;
}

function sortRankAsc(a: RankedCell, b: RankedCell): number {
  const ds = a.score - b.score;
  if (ds !== 0) return ds;
  if (a.i !== b.i) return a.i - b.i;
  return a.j - b.j;
}
