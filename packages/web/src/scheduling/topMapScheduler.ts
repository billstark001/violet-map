import { surfaceRepresentationAllowed } from '../view/representation';
import { TOP_MAP_TILE_BLOCKS } from '@violet-map/core/formats/top-map';
import type { ViewState } from '../view/state';
import { buildTileCoverage, type TileCoverage } from '../view/topMapCoverage';
import { planTopMapTiles, topMapViewMetrics, type RegionCoordinate } from './topMapPlanner';
import {
  TOP_MAP_MAX_RADIUS_BLOCKS,
  TOP_MAP_MAX_WANTED_TILES,
  TOP_MAP_MAX_PENDING_TILES,
  TOP_MAP_TILE_RETRY_MS,
  TOP_MAP_UPDATE_INTERVAL_MS,
} from './topMapPolicy';

export interface TopMapDemand extends RegionCoordinate {
  step: number;
  coverageKey: string;
  mask: Uint8Array | undefined;
}

export interface TopMapFramePlan {
  wanted: ReadonlyMap<string, TopMapDemand>;
  load: TopMapDemand[];
  cancel: string[];
  evict: string[];
}

export class TopMapScheduler {
  private wanted = new Map<string, TopMapDemand>();
  private readonly resident = new Map<string, number>();
  private coverageSource: ReadonlySet<string> | null = null;
  private coverage = new Map<string, TileCoverage>();
  private lastUpdate = -Infinity;

  constructor(private readonly residentLimit: number) {
    if (!Number.isSafeInteger(residentLimit) || residentLimit < 1)
      throw new RangeError('invalid Top Map resident limit');
  }

  demandFor(key: string): Readonly<TopMapDemand> | undefined {
    return this.wanted.get(key);
  }

  wantedKeys(): ReadonlySet<string> {
    return new Set(this.wanted.keys());
  }

  residentSince(key: string): number {
    const used = this.resident.get(key);
    if (used === undefined) throw new Error('Top Map resident was not registered: ' + key);
    return used;
  }

  loaded(key: string, now: number) {
    this.resident.set(key, now);
  }

  removed(key: string) {
    this.resident.delete(key);
  }

  clear() {
    this.wanted.clear();
    this.resident.clear();
    this.coverage.clear();
    this.coverageSource = null;
    this.lastUpdate = -Infinity;
  }

  plan(input: {
    view: ViewState;
    now: number;
    regions: ReadonlyMap<string, RegionCoordinate>;
    pending: ReadonlySet<string>;
    failed: ReadonlyMap<string, number>;
    onlineChunks: ReadonlySet<string>;
  }): TopMapFramePlan | null {
    if (input.now - this.lastUpdate < TOP_MAP_UPDATE_INTERVAL_MS) return null;
    this.lastUpdate = input.now;
    if (this.coverageSource !== input.onlineChunks) {
      this.coverageSource = input.onlineChunks;
      this.coverage = buildTileCoverage(input.onlineChunks);
    }
    const view = topMapViewMetrics(input.view);
    const radiusX = view.width / 2 + TOP_MAP_TILE_BLOCKS,
      radiusZ = view.height / 2 + TOP_MAP_TILE_BLOCKS;
    const candidates = surfaceRepresentationAllowed(input.view.mode, input.view.clip)
      ? planTopMapTiles(input.regions, {
          bounds: {
            minRx: Math.floor((input.view.position.x - radiusX) / TOP_MAP_TILE_BLOCKS),
            maxRx: Math.floor((input.view.position.x + radiusX) / TOP_MAP_TILE_BLOCKS),
            minRz: Math.floor((input.view.position.z - radiusZ) / TOP_MAP_TILE_BLOCKS),
            maxRz: Math.floor((input.view.position.z + radiusZ) / TOP_MAP_TILE_BLOCKS),
          },
          cameraX: input.view.position.x,
          cameraZ: input.view.position.z,
          maxDistanceBlocks: TOP_MAP_MAX_RADIUS_BLOCKS,
          limit: Math.min(TOP_MAP_MAX_WANTED_TILES, this.residentLimit),
          mode: input.view.mode,
          zoom: view.zoom,
        })
      : [];
    this.wanted = new Map();
    for (const candidate of candidates) {
      const coverage = this.coverage.get(candidate.key);
      if (coverage?.key === '*' && !this.resident.has(candidate.key)) continue;
      this.wanted.set(candidate.key, { ...candidate, coverageKey: coverage ? coverage.key : '', mask: coverage?.mask });
      if (this.resident.has(candidate.key)) this.resident.set(candidate.key, input.now);
    }
    const cancel = [...input.pending].filter((key) => !this.wanted.has(key));
    let capacity = TOP_MAP_MAX_PENDING_TILES - input.pending.size + cancel.length;
    const load: TopMapDemand[] = [];
    for (const demand of this.wanted.values()) {
      if (capacity <= 0) break;
      if (this.resident.has(demand.key) || input.pending.has(demand.key)) continue;
      const failed = input.failed.get(demand.key);
      if (failed !== undefined && input.now - failed < TOP_MAP_TILE_RETRY_MS) continue;
      load.push(demand);
      capacity--;
    }
    const evict = [...this.resident]
      .filter(([key]) => !this.wanted.has(key))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, this.resident.size - this.residentLimit))
      .map(([key]) => key);
    return { wanted: this.wanted, load, cancel, evict };
  }
}
