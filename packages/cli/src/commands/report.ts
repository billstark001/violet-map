import { performance } from 'node:perf_hooks';
import type { MeshBuffers, SectionMeshes } from '@violet-map/render';

export interface MeshStats {
  vertices: number;
  indices: number;
  sections: number;
}

export interface TimedMeshStats extends MeshStats {
  ms: number;
}

export interface Summary extends MeshStats {
  label: string;
  samples: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export function meshStats(mesh: MeshBuffers | null | undefined): MeshStats {
  if (!mesh) return { vertices: 0, indices: 0, sections: 0 };
  return { vertices: mesh.positions.length / 3, indices: mesh.indices.length, sections: 1 };
}

export function sectionStats(sections: SectionMeshes): MeshStats {
  const total: MeshStats = { vertices: 0, indices: 0, sections: 0 };
  for (const mesh of Object.values(sections)) {
    total.vertices += mesh.positions.length / 3;
    total.indices += mesh.indices.length;
  }
  if (total.vertices > 0) total.sections = 1;
  return total;
}

export function addStats(a: MeshStats, b: MeshStats): MeshStats {
  a.vertices += b.vertices;
  a.indices += b.indices;
  a.sections += b.sections;
  return a;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function summarize(label: string, samples: TimedMeshStats[]): Summary {
  const times = samples.map((s) => s.ms);
  const totalMs = times.reduce((a, b) => a + b, 0);
  return {
    label,
    samples: samples.length,
    totalMs,
    avgMs: totalMs / Math.max(1, samples.length),
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: Math.max(0, ...times),
    vertices: samples.reduce((a, b) => a + b.vertices, 0),
    indices: samples.reduce((a, b) => a + b.indices, 0),
    sections: samples.reduce((a, b) => a + b.sections, 0),
  };
}

export function formatMs(v: number): string {
  return v.toFixed(2).padStart(8);
}

export function printSummaryTable(summaries: Summary[]) {
  console.log('');
  console.log('label       samples    total      avg      p50      p95      max      verts      indices');
  console.log('----------  -------  -------  -------  -------  -------  -------  ---------  ----------');
  for (const s of summaries) {
    console.log(
      [
        s.label.padEnd(10),
        String(s.samples).padStart(7),
        formatMs(s.totalMs),
        formatMs(s.avgMs),
        formatMs(s.p50Ms),
        formatMs(s.p95Ms),
        formatMs(s.maxMs),
        String(Math.round(s.vertices / Math.max(1, s.samples))).padStart(9),
        String(Math.round(s.indices / Math.max(1, s.samples))).padStart(10),
      ].join('  '),
    );
  }
}

export function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}
