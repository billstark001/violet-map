import {
  prepareTopMapTile,
  TOP_MAP_MISSING_HEIGHT,
  TOP_MAP_TILE_BLOCKS,
  type PreparedTopMapTile,
} from '@violet-map/core/formats/top-map';
import type { ViewState } from '../view/state';
import { TOP_MAP_MANIFEST_RETRY_MS } from '../scheduling/topMapPolicy';
import { fetchTopMapManifest, fetchTopMapTile } from '../api';
import { debugLog } from '../logger';
import { resourceClient } from '../resources/client';
import type { TopMapDisplay } from './topMapDisplay';
import type { RegionCoordinate } from '../scheduling/topMapPlanner';
import { TopMapScheduler } from '../scheduling/topMapScheduler';

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface TopMapDiagnosticSnapshot {
  world: string;
  dimension: string;
  enabled: boolean;
  manifestLoaded: boolean;
  availableTiles: number;
  pendingTiles: string[];
  wantedTiles: string[];
  residentTiles: {
    key: string;
    step: number;
    coverageKey: string;
    visible: boolean;
    meshBytes: number;
    lastUsed: number;
  }[];
}

interface TopMapTile {
  key: string;
  data: PreparedTopMapTile;
}

export class TopMapRuntime {
  private readonly tiles = new Map<string, TopMapTile>();
  private readonly pendingTiles = new Set<string>();
  private readonly tileAborts = new Map<string, AbortController>();
  private readonly tileDigests = new Map<string, string>();
  private readonly unsubscribe: () => void;
  private world = '';
  private dimension = '';
  private topMapEnabled = false;
  private manifestLoaded = false;
  private manifestSeq = 0;
  private manifestRetryAt = 0;
  private regions = new Map<string, RegionCoordinate>();
  private failedTiles = new Map<string, number>();
  private disposed = false;
  private manifestAbort: AbortController | null = null;
  private sourceScope = '';

  private readonly scheduler: TopMapScheduler;

  constructor(
    private readonly display: TopMapDisplay,
    residentLimit: number,
  ) {
    this.scheduler = new TopMapScheduler(residentLimit);
    this.display.setEnabled(false);
    this.unsubscribe = resourceClient.subscribe(() => {
      const scope = resourceClient.current(this.world)?.sourceScope ?? '';
      if (scope !== this.sourceScope) {
        this.sourceScope = scope;
        this.abortPendingLoads();
        this.pendingTiles.clear();
        this.failedTiles.clear();
        this.tileDigests.clear();
        this.manifestLoaded = false;
        this.clearTiles();
        this.scheduler.clear();
      }
      if (this.topMapEnabled && !this.disposed) void this.loadManifest(this.world, this.dimension, ++this.manifestSeq);
    });
  }

  configure(world: string, dimension: string, topMapEnabled: boolean) {
    if (this.disposed) return;
    if (this.world === world && this.dimension === dimension && this.topMapEnabled === topMapEnabled) return;
    this.world = world;
    this.sourceScope = resourceClient.current(world)?.sourceScope ?? '';
    this.dimension = dimension;
    this.topMapEnabled = topMapEnabled;
    this.manifestLoaded = !topMapEnabled;
    this.manifestRetryAt = 0;
    this.manifestSeq++;
    this.abortPendingLoads();
    this.regions.clear();
    this.display.setEnabled(topMapEnabled);
    this.pendingTiles.clear();
    this.failedTiles.clear();
    this.clearTiles();
    this.scheduler.clear();
    debugLog('top-map', 'configure', { world, dimension, topMapEnabled });
    if (topMapEnabled) void this.loadManifest(world, dimension, this.manifestSeq);
  }

  update(viewState: ViewState, now: number, onlineChunks: ReadonlySet<string>) {
    if (this.disposed) return;
    const topMapAllowed = this.topMapEnabled && (!this.manifestLoaded || this.regions.size > 0);
    if (!topMapAllowed || !this.world) {
      this.display.setEnabled(false);
      return;
    }
    if (!this.manifestLoaded) {
      this.display.setEnabled(false);
      if (!this.manifestAbort && now >= this.manifestRetryAt)
        void this.loadManifest(this.world, this.dimension, this.manifestSeq);
      return;
    }
    const plan = this.scheduler.plan({
      view: viewState,
      now,
      regions: this.regions,
      pending: this.pendingTiles,
      failed: this.failedTiles,
      onlineChunks,
    });
    if (!plan) return;
    this.display.setEnabled(true);
    for (const key of plan.cancel) {
      this.tileAborts.get(key)!.abort();
      this.tileAborts.delete(key);
      this.pendingTiles.delete(key);
    }
    for (const demand of plan.wanted.values())
      if (this.tiles.has(demand.key)) this.display.update(demand.key, demand.step, demand.coverageKey, demand.mask);
    this.display.setWanted(new Set(plan.wanted.keys()));
    for (const key of plan.evict) this.removeTile(key);
    for (const demand of plan.load) void this.loadTile(demand.rx, demand.rz, demand.key);
    debugLog('top-map', 'update', {
      mode: viewState.mode,
      wanted: plan.wanted.size,
      resident: this.tiles.size,
      pending: this.pendingTiles.size,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.manifestSeq++;
    this.abortPendingLoads();
    this.pendingTiles.clear();
    this.clearTiles();
    this.scheduler.clear();
    this.display.dispose();
  }

  surfaceYAtChunk(cx: number, cz: number): number | null {
    const blocksPerChunk = 16;
    const worldX = cx * blocksPerChunk + blocksPerChunk / 2;
    const worldZ = cz * blocksPerChunk + blocksPerChunk / 2;
    const rx = Math.floor(worldX / TOP_MAP_TILE_BLOCKS);
    const rz = Math.floor(worldZ / TOP_MAP_TILE_BLOCKS);
    const tile = this.tiles.get(`${rx},${rz}`);
    if (!tile) return null;

    const localX = worldX - tile.data.payload.origin.x;
    const localZ = worldZ - tile.data.payload.origin.z;
    const stride = tile.data.payload.sampleStride;
    const samples = tile.data.payload.size.samples;
    const sx = Math.max(0, Math.min(samples - 1, Math.floor(localX / stride)));
    const sz = Math.max(0, Math.min(samples - 1, Math.floor(localZ / stride)));
    const height = tile.data.heights[sz * samples + sx];
    return height === TOP_MAP_MISSING_HEIGHT ? null : height;
  }

  diagnosticSnapshot(): TopMapDiagnosticSnapshot {
    return {
      world: this.world,
      dimension: this.dimension,
      enabled: this.topMapEnabled,
      manifestLoaded: this.manifestLoaded,
      availableTiles: this.regions.size,
      pendingTiles: [...this.pendingTiles].sort(),
      wantedTiles: [...this.scheduler.wantedKeys()].sort(),
      residentTiles: [...this.tiles.values()]
        .map((tile) => ({
          key: tile.key,
          ...this.display.snapshot(tile.key),
          lastUsed: this.scheduler.residentSince(tile.key),
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  private async loadManifest(world: string, dimension: string, seq: number) {
    const abort = new AbortController();
    this.manifestAbort?.abort();
    this.manifestAbort = abort;
    try {
      const manifest = await fetchTopMapManifest(world, dimension, abort.signal);
      if (this.disposed || seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.sourceScope = resourceClient.current(world)!.sourceScope;
      if (manifest.hasTopMap && manifest.topMap?.regions.some((region) => !region.artifact))
        throw new Error('topmap manifest has no current artifact references');
      const nextDigests = new Map(
        (manifest.topMap?.regions ?? []).map((region) => [`${region.x},${region.z}`, region.artifact!.digest]),
      );
      for (const [key, digest] of this.tileDigests)
        if (nextDigests.get(key) !== digest) {
          this.tileAborts.get(key)?.abort();
          this.tileAborts.delete(key);
          this.pendingTiles.delete(key);
          this.removeTile(key);
          this.failedTiles.delete(key);
        }
      this.tileDigests.clear();
      for (const [key, digest] of nextDigests) this.tileDigests.set(key, digest);
      this.regions = new Map(
        (manifest.hasTopMap ? (manifest.topMap?.regions ?? []) : [])
          .filter((region) => Number.isSafeInteger(region.x) && Number.isSafeInteger(region.z))
          .map((region) => {
            const key = `${region.x},${region.z}`;
            return [key, { rx: region.x, rz: region.z, key }] as const;
          }),
      );
      this.manifestLoaded = true;
      this.manifestRetryAt = 0;
      debugLog('top-map', 'manifest-loaded', {
        world,
        dimension,
        tiles: this.regions.size,
        topMapEnabled: this.topMapEnabled && this.regions.size > 0,
      });
    } catch (error) {
      if (isAbortError(error) || abort.signal.aborted) return;
      if (this.disposed || seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.manifestLoaded = false;
      this.manifestRetryAt = performance.now() + TOP_MAP_MANIFEST_RETRY_MS;
      debugLog('top-map', 'manifest-error', {
        world,
        dimension,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.manifestAbort === abort) this.manifestAbort = null;
    }
  }

  private async loadTile(rx: number, rz: number, key: string) {
    if (
      this.disposed ||
      this.pendingTiles.has(key) ||
      this.tiles.has(key) ||
      !this.topMapEnabled ||
      !this.regions.has(key)
    )
      return;
    this.pendingTiles.add(key);
    const abort = new AbortController();
    this.tileAborts.set(key, abort);
    const world = this.world;
    const dimension = this.dimension;
    const digest = this.tileDigests.get(key);
    try {
      const payload = await fetchTopMapTile(world, dimension, rx, rz, abort.signal);
      if (
        abort.signal.aborted ||
        this.disposed ||
        world !== this.world ||
        dimension !== this.dimension ||
        !this.topMapEnabled ||
        this.tileDigests.get(key) !== digest
      )
        return;
      const data = prepareTopMapTile(payload);
      const tile: TopMapTile = {
        key,
        data,
      };
      this.failedTiles.delete(key);
      this.tiles.set(key, tile);
      this.scheduler.loaded(key, performance.now());
      this.display.add(key, data);
      const demand = this.scheduler.demandFor(key);
      if (demand) this.display.update(key, demand.step, demand.coverageKey, demand.mask);
      debugLog('top-map', 'tile-loaded', { key, rx, rz, chunks: payload.chunks, approach: payload.approach });
    } catch (error) {
      if (isAbortError(error) || abort.signal.aborted || this.tileAborts.get(key) !== abort) return;
      if (this.disposed || world !== this.world || dimension !== this.dimension) return;
      this.failedTiles.set(key, performance.now());
      debugLog('top-map', 'tile-error', { key, rx, rz, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.tileAborts.get(key) === abort) {
        this.tileAborts.delete(key);
        this.pendingTiles.delete(key);
      }
    }
  }

  private clearTiles() {
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  private abortPendingLoads() {
    this.manifestAbort?.abort();
    this.manifestAbort = null;
    for (const abort of this.tileAborts.values()) abort.abort();
    this.tileAborts.clear();
  }

  private removeTile(key: string) {
    if (!this.tiles.delete(key)) return;
    this.scheduler.removed(key);
    this.display.remove(key);
  }
}
