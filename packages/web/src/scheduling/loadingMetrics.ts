import type { ChunkDiagnosticOp, ChunkDiagnosticEvent } from './contracts';

const DIAGNOSTIC_HISTORY_LIMIT = 32;
const DIAGNOSTIC_MIN_SAMPLES = 8;
const DIAGNOSTIC_STDDEV_FACTOR = 3;
const DIAGNOSTIC_DELAY_CHECK_MS = 1000;
const DIAGNOSTIC_MIN_SLOW_MS: Record<ChunkDiagnosticOp, number> = {
  hashFetch: 450,
  chunkFetch: 900,
  parse: 90,
  fullMesh: 180,
  lodMesh: 120,
};
const DIAGNOSTIC_MIN_DELAY_MS: Record<ChunkDiagnosticOp, number> = {
  hashFetch: 1500,
  chunkFetch: 2500,
  parse: 0,
  fullMesh: 2500,
  lodMesh: 1800,
};

interface ProfileSample {
  total: number;
  count: number;
  mean: number;
  m2: number;
}

interface ActiveDiagnosticOperation {
  id: number;
  op: Exclude<ChunkDiagnosticOp, 'parse'>;
  detail: string;
  startedAt: number;
  profile: ProfileSample;
  reportedDelayed: boolean;
}

function profileSample(): ProfileSample {
  return { total: 0, count: 0, mean: 0, m2: 0 };
}

export class LoadingMetrics {
  private diagnostics: ChunkDiagnosticEvent[] = [];
  private diagnosticSeq = 0;
  private activeDiagnostics = new Map<number, ActiveDiagnosticOperation>();
  private activeDiagnosticSeq = 0;
  private lastDiagnosticDelayCheck = 0;
  private profiles: Record<ChunkDiagnosticOp, ProfileSample> = {
    hashFetch: profileSample(),
    chunkFetch: profileSample(),
    parse: profileSample(),
    fullMesh: profileSample(),
    lodMesh: profileSample(),
  };
  private sample(profile: ProfileSample, value: number | undefined) {
    if (value === undefined || !Number.isFinite(value) || value < 0) return;
    profile.total += value;
    profile.count++;
    const delta = value - profile.mean;
    profile.mean += delta / profile.count;
    profile.m2 += delta * (value - profile.mean);
  }

  private average(profile: ProfileSample): number {
    return profile.count > 0 ? profile.total / profile.count : 0;
  }

  private stddev(profile: ProfileSample): number {
    return profile.count > 1 ? Math.sqrt(profile.m2 / (profile.count - 1)) : 0;
  }

  private slowThreshold(op: ChunkDiagnosticOp, profile: ProfileSample): number {
    if (profile.count < DIAGNOSTIC_MIN_SAMPLES) return Infinity;
    return Math.max(DIAGNOSTIC_MIN_SLOW_MS[op], profile.mean + this.stddev(profile) * DIAGNOSTIC_STDDEV_FACTOR);
  }

  private delayThreshold(op: Exclude<ChunkDiagnosticOp, 'parse'>, profile: ProfileSample): number {
    if (profile.count < DIAGNOSTIC_MIN_SAMPLES) return DIAGNOSTIC_MIN_DELAY_MS[op];
    return Math.max(DIAGNOSTIC_MIN_DELAY_MS[op], profile.mean + this.stddev(profile) * DIAGNOSTIC_STDDEV_FACTOR);
  }

  private addDiagnostic(
    kind: ChunkDiagnosticEvent['kind'],
    op: ChunkDiagnosticOp,
    detail: string,
    durationMs: number,
    thresholdMs: number,
    sampleCount: number,
  ) {
    this.diagnostics.unshift({
      id: ++this.diagnosticSeq,
      time: Date.now(),
      kind,
      op,
      detail,
      durationMs,
      thresholdMs,
      sampleCount,
    });
    if (this.diagnostics.length > DIAGNOSTIC_HISTORY_LIMIT) this.diagnostics.length = DIAGNOSTIC_HISTORY_LIMIT;
  }

  record(op: ChunkDiagnosticOp, durationMs: number | undefined, detail: string) {
    const profile = this.profiles[op];
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return;
    const threshold = this.slowThreshold(op, profile);
    const sampleCount = profile.count;
    if (durationMs > threshold) this.addDiagnostic('slow', op, detail, durationMs, threshold, sampleCount);
    this.sample(profile, durationMs);
  }

  begin(op: Exclude<ChunkDiagnosticOp, 'parse'>, detail: string): number {
    const id = ++this.activeDiagnosticSeq;
    this.activeDiagnostics.set(id, {
      id,
      op,
      detail,
      profile: this.profiles[op],
      startedAt: performance.now(),
      reportedDelayed: false,
    });
    return id;
  }

  finish(id: number, durationMs?: number) {
    const op = this.activeDiagnostics.get(id);
    if (!op) return;
    this.activeDiagnostics.delete(id);
    const duration = durationMs ?? performance.now() - op.startedAt;
    if (op.reportedDelayed) this.sample(op.profile, duration);
    else this.record(op.op, duration, op.detail);
  }

  checkDelayed(now: number) {
    if (now - this.lastDiagnosticDelayCheck < DIAGNOSTIC_DELAY_CHECK_MS) return;
    this.lastDiagnosticDelayCheck = now;
    for (const op of this.activeDiagnostics.values()) {
      if (op.reportedDelayed) continue;
      const duration = now - op.startedAt;
      const threshold = this.delayThreshold(op.op, op.profile);
      if (duration <= threshold) continue;
      op.reportedDelayed = true;
      this.addDiagnostic('delayed', op.op, op.detail, duration, threshold, op.profile.count);
    }
  }

  snapshot() {
    return {
      diagnostics: [...this.diagnostics],
      hashFetchMsAvg: this.average(this.profiles.hashFetch),
      chunkFetchMsAvg: this.average(this.profiles.chunkFetch),
      parseMsAvg: this.average(this.profiles.parse),
      fullMeshMsAvg: this.average(this.profiles.fullMesh),
      lodMeshMsAvg: this.average(this.profiles.lodMesh),
    };
  }
  clear() {
    this.activeDiagnostics.clear();
    this.diagnostics.length = 0;
  }
}
