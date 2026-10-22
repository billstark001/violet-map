import {
  prepareTopMapTile,
  TOP_MAP_MISSING_HEIGHT,
  TOP_MAP_TILE_BLOCKS,
  type PreparedTopMapTile,
} from '@violet-map/core/formats/top-map';
import { topMapCoverageKeyFromMask } from '@violet-map/render/top-map/mesh';
import * as THREE from 'three';
import { fetchTopMapManifest, fetchTopMapTile } from '../api';
import { debugLog } from '../logger';
import { resourceClient } from '../resources/client';
import type { TopMapDisplay } from '../runtime/topMapDisplay';
import { planTopMapTiles, topMapLodStep, type RegionCoordinate } from './topMapPlanner';

const MAX_RESIDENT_TILES = 96;
const MAX_WANTED_TILES = 96;
const MAX_PENDING_TILES = 6;
const FAILED_TILE_RETRY_MS = 12000;
const FAILED_MANIFEST_RETRY_MS = 5000;
const UPDATE_INTERVAL_MS = 100;
const FULL_COVERAGE_KEY = '*';
const TOP_MAP_CHUNKS_PER_AXIS = TOP_MAP_TILE_BLOCKS / 16;
const TOP_MAP_CHUNK_MASK_BYTES = (TOP_MAP_CHUNKS_PER_AXIS * TOP_MAP_CHUNKS_PER_AXIS) / 8;

function residentTileBudget(): number {
  const memory =
    typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
  if (memory !== undefined && memory <= 4) return Math.min(MAX_RESIDENT_TILES, 48);
  if (memory !== undefined && memory <= 8) return Math.min(MAX_RESIDENT_TILES, 72);
  return MAX_RESIDENT_TILES;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface TopMapUpdateOptions {
  mode: 'perspective' | 'top';
  radiusBlocks?: number;
  /** Hard radial cutoff around the active camera. */
  maxDistanceBlocks?: number;
  onlineChunks?: ReadonlySet<string>;
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
  lastUsed: number;
}

interface TileCoverage {
  key: string;
  mask: Uint8Array;
}

function buildTileCoverage(onlineChunks: ReadonlySet<string> | undefined): Map<string, TileCoverage> {
  const masks = new Map<string, Uint8Array>();
  if (!onlineChunks?.size) return new Map();
  for (const chunkKey of onlineChunks) {
    const separator = chunkKey.indexOf(',');
    if (separator < 1) continue;
    const cx = Number(chunkKey.slice(0, separator));
    const cz = Number(chunkKey.slice(separator + 1));
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) continue;
    const rx = Math.floor(cx / TOP_MAP_CHUNKS_PER_AXIS);
    const rz = Math.floor(cz / TOP_MAP_CHUNKS_PER_AXIS);
    const tileKey = `${rx},${rz}`;
    let mask = masks.get(tileKey);
    if (!mask) {
      mask = new Uint8Array(TOP_MAP_CHUNK_MASK_BYTES);
      masks.set(tileKey, mask);
    }
    const localX = cx - rx * TOP_MAP_CHUNKS_PER_AXIS;
    const localZ = cz - rz * TOP_MAP_CHUNKS_PER_AXIS;
    const index = localZ * TOP_MAP_CHUNKS_PER_AXIS + localX;
    mask[index >> 3] |= 1 << (index & 7);
  }
  const coverage = new Map<string, TileCoverage>();
  for (const [key, mask] of masks) coverage.set(key, { key: topMapCoverageKeyFromMask(mask), mask });
  return coverage;
}

export class TopMapManager {
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
  private wantedTiles = new Set<string>();
  private latestMode: TopMapUpdateOptions['mode'] = 'top';
  private latestCameraX = 0;
  private latestCameraZ = 0;
  private latestZoom = 1;
  private latestCoverage = new Map<string, TileCoverage>();
  private coverageSource: ReadonlySet<string> | undefined;
  private lastUpdateAt = -Infinity;
  private disposed = false;
  private readonly residentLimit = residentTileBudget();
  private manifestAbort: AbortController | null = null;
  private sourceScope = '';

  constructor(private readonly display: TopMapDisplay) {
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
    this.wantedTiles.clear();
    this.latestCoverage.clear();
    this.coverageSource = undefined;
    this.lastUpdateAt = -Infinity;
    this.clearTiles();
    debugLog('top-map', 'configure', { world, dimension, topMapEnabled });
    if (topMapEnabled) void this.loadManifest(world, dimension, this.manifestSeq);
  }

  update(camera: THREE.Camera, now: number, options: TopMapUpdateOptions) {
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
    if (now - this.lastUpdateAt < UPDATE_INTERVAL_MS) return;
    this.lastUpdateAt = now;

    const view = this.viewMetrics(camera, options);
    this.latestMode = options.mode;
    this.latestCameraX = camera.position.x;
    this.latestCameraZ = camera.position.z;
    this.latestZoom = view.zoom;
    if (this.coverageSource !== options.onlineChunks) {
      this.coverageSource = options.onlineChunks;
      this.latestCoverage = buildTileCoverage(options.onlineChunks);
    }
    this.display.setEnabled(true);
    const radiusX = view.width / 2 + TOP_MAP_TILE_BLOCKS;
    const radiusZ = view.height / 2 + TOP_MAP_TILE_BLOCKS;
    const minRx = Math.floor((camera.position.x - radiusX) / TOP_MAP_TILE_BLOCKS);
    const maxRx = Math.floor((camera.position.x + radiusX) / TOP_MAP_TILE_BLOCKS);
    const minRz = Math.floor((camera.position.z - radiusZ) / TOP_MAP_TILE_BLOCKS);
    const maxRz = Math.floor((camera.position.z + radiusZ) / TOP_MAP_TILE_BLOCKS);
    const activeCandidates = planTopMapTiles(this.regions, {
      bounds: { minRx, maxRx, minRz, maxRz },
      cameraX: camera.position.x,
      cameraZ: camera.position.z,
      maxDistanceBlocks: options.maxDistanceBlocks,
      limit: Math.min(MAX_WANTED_TILES, this.residentLimit),
      mode: options.mode,
      zoom: view.zoom,
    });

    const wanted = new Set<string>();
    for (const candidate of activeCandidates) {
      const tile = this.tiles.get(candidate.key);
      const step = candidate.step;
      const coverage = this.latestCoverage.get(candidate.key);
      const coverageKey = coverage?.key ?? '';
      if (!tile && coverageKey === FULL_COVERAGE_KEY) continue;
      wanted.add(candidate.key);
      if (tile) {
        tile.lastUsed = now;
        this.display.update(tile.key, step, coverageKey, coverage?.mask);
      } else if (
        !this.pendingTiles.has(candidate.key) &&
        !this.tileFailedRecently(candidate.key, now) &&
        this.pendingTiles.size < MAX_PENDING_TILES
      ) {
        void this.loadTile(candidate.rx, candidate.rz, candidate.key, now, step);
      }
    }

    for (const [key, abort] of this.tileAborts) {
      if (wanted.has(key)) continue;
      abort.abort();
      this.tileAborts.delete(key);
      this.pendingTiles.delete(key);
    }
    this.display.setWanted(wanted);
    this.wantedTiles = wanted;
    this.evictTiles(wanted);
    debugLog('top-map', 'update', {
      mode: options.mode,
      candidates: activeCandidates.length,
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
    this.display.dispose();
    this.pendingTiles.clear();
    this.latestCoverage.clear();
    this.coverageSource = undefined;
    this.clearTiles();
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
      wantedTiles: [...this.wantedTiles].sort(),
      residentTiles: [...this.tiles.values()]
        .map((tile) => ({
          key: tile.key,
          ...this.display.snapshot(tile.key),
          lastUsed: tile.lastUsed,
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
      this.manifestRetryAt = performance.now() + FAILED_MANIFEST_RETRY_MS;
      debugLog('top-map', 'manifest-error', {
        world,
        dimension,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.manifestAbort === abort) this.manifestAbort = null;
    }
  }

  private async loadTile(rx: number, rz: number, key: string, now: number, step: number) {
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
        lastUsed: now,
      };
      this.failedTiles.delete(key);
      this.tiles.set(key, tile);
      this.display.add(key, data);
      if (this.wantedTiles.has(key)) {
        const latestCoverage = this.latestCoverage.get(key);
        const latestCoverageKey = latestCoverage?.key ?? '';
        this.display.update(key, this.latestStepForTile(rx, rz), latestCoverageKey, latestCoverage?.mask);
      }
      debugLog('top-map', 'tile-loaded', { key, rx, rz, chunks: payload.chunks, step, approach: payload.approach });
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

  private latestStepForTile(rx: number, rz: number): number {
    const centerX = rx * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
    const centerZ = rz * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
    return topMapLodStep(
      Math.hypot(centerX - this.latestCameraX, centerZ - this.latestCameraZ),
      this.latestMode,
      this.latestZoom,
    );
  }

  private tileFailedRecently(key: string, now: number): boolean {
    const failedAt = this.failedTiles.get(key);
    if (failedAt === undefined) return false;
    if (now - failedAt < FAILED_TILE_RETRY_MS) return true;
    this.failedTiles.delete(key);
    return false;
  }

  private evictTiles(wanted: ReadonlySet<string>) {
    if (this.tiles.size <= this.residentLimit) return;
    const stale = [...this.tiles.values()]
      .filter((tile) => !wanted.has(tile.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let resident = this.tiles.size;
    for (const tile of stale) {
      if (resident <= this.residentLimit) break;
      this.removeTile(tile.key);
      resident--;
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
    this.display.remove(key);
  }

  private viewMetrics(
    camera: THREE.Camera,
    options: TopMapUpdateOptions,
  ): { width: number; height: number; zoom: number } {
    if (options.mode === 'perspective') {
      const size = Math.max(TOP_MAP_TILE_BLOCKS, options.radiusBlocks ?? TOP_MAP_TILE_BLOCKS * 2);
      return { width: size * 2, height: size * 2, zoom: 1 };
    }
    if (camera instanceof THREE.OrthographicCamera) {
      const height = (camera.top - camera.bottom) / camera.zoom;
      const aspect = (camera.right - camera.left) / Math.max(1e-3, camera.top - camera.bottom);
      return { width: height * aspect, height, zoom: camera.zoom };
    }
    if (camera instanceof THREE.PerspectiveCamera) {
      const height = 2 * Math.max(1, camera.position.y) * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      return { width: height * camera.aspect, height, zoom: TOP_MAP_TILE_BLOCKS / Math.max(1, height) };
    }
    return { width: TOP_MAP_TILE_BLOCKS * 2, height: TOP_MAP_TILE_BLOCKS * 2, zoom: 1 };
  }
}
