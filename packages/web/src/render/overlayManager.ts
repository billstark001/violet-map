import {
  normalizeContentDimension,
  parseOverlayManifest,
  type CurveFeature,
  type OverlayFeature,
  type OverlayManifest,
  type OverlayMediaReference,
} from '@violet-map/core/overlays';
import {
  boundsOf,
  buildAreaFill,
  buildAreaWall,
  curveBounds,
  mediaBounds,
  sampleCurve,
  type OverlayBounds,
} from '@violet-map/render/overlays';
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { log } from '../logger';
import { resourceClient } from '../resources/client';
import { apiFetch } from '../runtime';
import type { SharedUniforms } from './materials';
import { OVERLAY_LIMITS } from './overlayLimits';
import { OverlayMask, createMaskMaterial } from './overlayMask';
import { loadOverlayMedia, type OverlayMediaResource } from './overlayMedia';
import { OverlayResourcePool, type ResourceLease } from '../scheduling/overlayResources';

const REFRESH_MS = 30_000;
const RETRY_MS = 12_000;
const MANIFEST_TIMEOUT_MS = 30_000;

export interface OverlayDiagnosticSnapshot {
  mapId: string | null;
  dimension: string;
  enabled: boolean;
  loading: boolean;
  sourceStatus: string | null;
  features: number;
  active: number;
  suppressed: number;
  versions: number;
  pending: number;
  resourceBytes: number;
  maskBytes: number;
  maskLimited: boolean;
  samplingLimited: number;
  curvePoints: number;
  errors: { feature: string; message: string }[];
}

interface RecordBase {
  key: string;
  feature: OverlayFeature;
  order: number;
  bounds: OverlayBounds;
  object?: THREE.Object3D;
  fill?: THREE.Mesh;
  lease?: ResourceLease<OverlayMediaResource>;
  retryAt?: number;
  curve?: { material: LineMaterial; positions: number[]; capped: boolean };
  dispose?: () => void;
}

export interface OverlayFrame {
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  topView: boolean;
  width: number;
  height: number;
  now: number;
  dayFactor: number;
  sky: 'normal' | 'nether' | 'end';
  ambient: number;
  surfaceMaxY: number;
}

export class OverlayManager {
  readonly group = new THREE.Group();
  private readonly mask: OverlayMask;
  private readonly records = new Map<string, RecordBase>();
  private pool = new OverlayResourcePool<OverlayMediaResource>();
  private media = new Map<string, OverlayMediaReference>();
  private readonly lights = new THREE.Group();
  private readonly hemisphere = new THREE.HemisphereLight(0xffffff, 0x888899, 1);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  private readonly issues = new Map<string, string>();
  private abort: AbortController | null = null;
  private mapId: string | null = null;
  private dimension = '';
  private enabled = false;
  private loading = false;
  private disposed = false;
  private generation = 0;
  private nextRefresh = 0;
  private etag: string | undefined;
  private sourceStatus: string | null = null;
  private suppressed = 0;
  private samplingLimited = 0;
  private curvePoints = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly lastMatrix = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly box = new THREE.Box3();
  private lastViewport = '';
  constructor(
    private readonly scene: THREE.Scene,
    private readonly shared: SharedUniforms,
    private readonly dependencies: {
      manifest?: typeof apiFetch;
      media?: typeof loadOverlayMedia;
      head?: typeof resourceClient.head;
    } = {},
  ) {
    this.mask = new OverlayMask(shared);
    this.group.name = 'map-overlays';
    scene.add(this.group);
    this.sun.position.set(0.4, 1, 0.25);
    this.lights.add(this.hemisphere, this.sun);
    this.lights.visible = false;
    scene.add(this.lights);
  }
  configure(mapId: string | null, dimension: string, enabled: boolean) {
    if (this.disposed) return;
    const dim = normalizeContentDimension(dimension);
    const active = !!mapId && enabled;
    if (this.mapId === mapId && this.dimension === dim && this.enabled === active) return;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.loading = false;
    this.clear();
    this.pool.dispose();
    this.pool = new OverlayResourcePool<OverlayMediaResource>();
    this.mapId = mapId;
    this.dimension = dim;
    this.enabled = active;
    this.etag = undefined;
    this.sourceStatus = null;
    this.nextRefresh = 0;
    if (active) void this.refresh();
  }
  async refresh() {
    if (this.disposed || !this.enabled || !this.mapId || this.loading) return;
    const generation = this.generation,
      mapId = this.mapId,
      dimension = this.dimension,
      controller = new AbortController();
    this.abort = controller;
    this.loading = true;
    try {
      const view = await (this.dependencies.head ?? resourceClient.head.bind(resourceClient))(
        '',
        false,
        controller.signal,
      );
      const response = await (this.dependencies.manifest ?? apiFetch)(
        `api/maps/${encodeURIComponent(mapId)}/overlays?dimension=${encodeURIComponent(dimension)}&viewId=${encodeURIComponent(view.viewId)}`,
        {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]),
          headers: this.etag ? { 'if-none-match': this.etag } : undefined,
        },
      );
      if (controller.signal.aborted || generation !== this.generation || this.disposed) return;
      if (response.status === 304) {
        this.issues.delete('manifest');
        return;
      }
      if (!response.ok) throw new Error(`overlay manifest: HTTP ${response.status}`);
      const manifest = parseOverlayManifest(await response.json());
      if (controller.signal.aborted || generation !== this.generation || this.disposed) return;
      if (!this.dependencies.head) resourceClient.assertCurrent(view);
      if (manifest.mapId !== mapId || manifest.dimension !== dimension)
        throw new Error('overlay manifest belongs to a different map/dimension');
      this.apply(manifest);
      this.etag = response.headers.get('etag') ?? undefined;
      this.issues.delete('manifest');
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation && !this.disposed) this.issue('manifest', error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.abort = null;
        this.nextRefresh = performance.now() + (this.issues.has('manifest') ? RETRY_MS : REFRESH_MS);
      }
    }
  }
  private apply(manifest: OverlayManifest) {
    this.sourceStatus = manifest.sourceStatus;
    const nextMedia = new Map(
      manifest.media.map((item) => [`${item.version.assetId}/${item.version.versionId}`, item]),
    );
    this.media = nextMedia;
    const wanted = new Set<string>();
    let order = 0;
    const layers = manifest.layers
      .slice()
      .sort((a, b) => a.binding.order - b.binding.order || a.binding.bindingId.localeCompare(b.binding.bindingId));
    if (['verified', 'unverified'].includes(manifest.sourceStatus))
      for (const layer of layers)
        for (const feature of layer.document.features.slice().sort((a, b) => a.featureId.localeCompare(b.featureId))) {
          const key = `${layer.binding.bindingId}/${layer.document.layerId}/${feature.featureId}`;
          wanted.add(key);
          const existing = this.records.get(key);
          if (existing && JSON.stringify(existing.feature) === JSON.stringify(feature)) {
            existing.order = order++;
            if (existing.object) this.orderObject(existing.object, existing.order);
            if (existing.fill) existing.fill.renderOrder = existing.order;
            continue;
          }
          if (existing) {
            this.release(existing);
            this.records.delete(key);
          }
          try {
            const bounds = this.featureBounds(feature);
            this.records.set(key, { key, feature, order: order++, bounds });
          } catch (error) {
            this.issue(key, error);
          }
        }
    for (const [key, record] of this.records)
      if (!wanted.has(key)) {
        this.release(record);
        this.records.delete(key);
        this.issues.delete(key);
      }
    for (const key of this.issues.keys()) if (key !== 'manifest' && !wanted.has(key)) this.issues.delete(key);
    const ordered = [...this.records.entries()].sort((a, b) => a[1].order - b[1].order);
    this.records.clear();
    for (const [key, record] of ordered) this.records.set(key, record);
    this.mask.invalidate();
    this.lastViewport = '';
  }
  private featureBounds(feature: OverlayFeature): OverlayBounds {
    if (feature.kind === 'curve')
      return curveBounds(feature, feature.style.widthUnit === 'blocks' ? feature.style.width / 2 : 0);
    if (feature.kind === 'area')
      return boundsOf(
        feature.ring.flatMap((p) => [
          [p[0], feature.minY, p[1]],
          [p[0], feature.maxY, p[1]],
        ]),
      );
    const item = this.media.get(`${feature.assetId}/${feature.versionId}`);
    if (!item) throw new Error(`unknown media version ${feature.assetId}/${feature.versionId}`);
    return mediaBounds(feature, item.version);
  }
  update(renderer: THREE.WebGLRenderer, frame: OverlayFrame) {
    if (this.disposed) return;
    if (!this.enabled) {
      this.shared.overlayMaskEnabled.value = 0;
      this.lights.visible = false;
      return;
    }
    if (
      !this.loading &&
      frame.now >= this.nextRefresh &&
      (typeof document === 'undefined' || document.visibilityState !== 'hidden')
    )
      void this.refresh();
    const camera = frame.camera;
    camera.updateMatrixWorld();
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    const viewport = `${frame.width}/${frame.height}`;
    const resample = !this.matrix.equals(this.lastMatrix) || viewport !== this.lastViewport;
    if (resample) {
      this.lastMatrix.copy(this.matrix);
      this.lastViewport = viewport;
    }
    this.suppressed = 0;
    this.samplingLimited = 0;
    let active = 0,
      hasMedia = false,
      maskBounds: { min: [number, number]; max: [number, number] } | null = null;
    const viewBounds = this.topBounds(frame);
    for (const record of this.records.values()) {
      const f = record.feature;
      let visible: boolean;
      if (f.kind === 'area' && frame.topView)
        visible =
          f.fill.opacity > 0 &&
          record.bounds.max[0] >= viewBounds.min[0] &&
          record.bounds.min[0] <= viewBounds.max[0] &&
          record.bounds.max[2] >= viewBounds.min[1] &&
          record.bounds.min[2] <= viewBounds.max[1];
      else {
        this.box.min.fromArray(record.bounds.min);
        this.box.max.fromArray(record.bounds.max);
        if (f.kind === 'curve' && f.style.widthUnit === 'pixels') {
          const distance =
            camera.position.distanceTo(this.box.getCenter(new THREE.Vector3())) +
            this.box.getSize(new THREE.Vector3()).length();
          const unit =
            camera instanceof THREE.PerspectiveCamera
              ? (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, frame.height)
              : (camera.top - camera.bottom) / camera.zoom / Math.max(1, frame.height);
          this.box.expandByScalar(unit * f.style.width);
        }
        visible = this.frustum.intersectsBox(this.box);
        if (f.kind === 'media') visible = visible && f.views.includes(frame.topView ? 'top' : 'player');
        if (f.kind === 'curve') visible = visible && f.style.opacity > 0;
        if (f.kind === 'area') visible = visible && f.wall.opacity > 0;
      }
      if (visible && active >= OVERLAY_LIMITS.activeFeatures) {
        visible = false;
        this.suppressed++;
      }
      if (!visible) {
        this.release(record);
        continue;
      }
      active++;
      if (record.retryAt && frame.now < record.retryAt) continue;
      if (!record.object && !record.fill && !record.lease) {
        try {
          this.activate(record, renderer);
        } catch (error) {
          record.retryAt = frame.now + RETRY_MS;
          this.issue(record.key, error);
        }
      }
      if (f.kind === 'curve' && record.object && (resample || !record.curve!.positions.length))
        this.sample(record, frame);
      if (record.curve?.capped) this.samplingLimited++;
      if (f.kind === 'media') {
        hasMedia = true;
        if (record.object && f.placement === 'billboard')
          record.object.quaternion
            .copy(camera.quaternion)
            .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...f.rotation, 'XYZ')));
      }
      if (f.kind === 'area') {
        if (frame.topView && record.fill) {
          record.fill.visible = true;
          if (record.object) record.object.visible = false;
          const min: [number, number] = [
              Math.max(record.bounds.min[0], viewBounds.min[0]),
              Math.max(record.bounds.min[2], viewBounds.min[1]),
            ],
            max: [number, number] = [
              Math.min(record.bounds.max[0], viewBounds.max[0]),
              Math.min(record.bounds.max[2], viewBounds.max[1]),
            ];
          if (!maskBounds) maskBounds = { min, max };
          else
            for (let axis = 0; axis < 2; axis++) {
              maskBounds.min[axis] = Math.min(maskBounds.min[axis], min[axis]);
              maskBounds.max[axis] = Math.max(maskBounds.max[axis], max[axis]);
            }
        } else {
          if (record.fill) record.fill.visible = false;
          if (record.object) record.object.visible = true;
        }
      }
    }
    this.mask.update(renderer, frame.topView ? maskBounds : null, this.worldPerPixel(frame));
    this.lights.visible = hasMedia;
    this.hemisphere.intensity =
      frame.sky === 'normal' ? 0.4 + frame.dayFactor * 1.1 : Math.max(0.65, frame.ambient * 2);
    this.hemisphere.color.set(frame.sky === 'nether' ? 0xffc0a0 : frame.sky === 'end' ? 0xc8bbff : 0xffffff);
    this.sun.intensity = frame.sky === 'normal' ? 0.3 + frame.dayFactor * 2 : 0.7;
  }
  private topBounds(frame: OverlayFrame) {
    const c = frame.camera;
    const halfH =
      c instanceof THREE.PerspectiveCamera
        ? (Math.max(c.near, c.position.y + 2048) * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) / c.zoom
        : (c.top - c.bottom) / c.zoom / 2;
    const halfW = c instanceof THREE.PerspectiveCamera ? halfH * c.aspect : (c.right - c.left) / c.zoom / 2;
    return {
      min: [c.position.x - halfW, c.position.z - halfH] as [number, number],
      max: [c.position.x + halfW, c.position.z + halfH] as [number, number],
    };
  }
  private worldPerPixel(frame: OverlayFrame) {
    const c = frame.camera;
    return c instanceof THREE.PerspectiveCamera
      ? (2 * Math.max(c.near, c.position.y - frame.surfaceMaxY) * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2)) /
          c.zoom /
          Math.max(1, frame.height)
      : (c.top - c.bottom) / c.zoom / Math.max(1, frame.height);
  }
  private orderObject(object: THREE.Object3D, order: number) {
    object.traverse((child) => {
      child.renderOrder = 100 + order;
    });
  }
  private activate(record: RecordBase, renderer: THREE.WebGLRenderer) {
    const feature = record.feature;
    record.retryAt = undefined;
    this.issues.delete(record.key);
    if (feature.kind === 'area') {
      const fill = buildAreaFill(feature),
        wall = buildAreaWall(feature);
      const fillGeometry = new THREE.BufferGeometry();
      fillGeometry.setAttribute('position', new THREE.BufferAttribute(fill.positions, 3));
      fillGeometry.setIndex(new THREE.BufferAttribute(fill.indices, 1));
      record.fill = new THREE.Mesh(fillGeometry, createMaskMaterial(feature.fill.color, feature.fill.opacity));
      record.fill.position.fromArray(fill.origin);
      record.fill.renderOrder = record.order;
      this.mask.scene.add(record.fill);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(wall.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(wall.indices, 1));
      geometry.computeBoundingSphere();
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(feature.wall.color).convertSRGBToLinear(),
        opacity: feature.wall.opacity,
        transparent: true,
        depthTest: feature.wall.occlusion === 'terrain',
        depthWrite: feature.wall.opacity === 1,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      record.object = new THREE.Mesh(geometry, material);
      record.object.position.fromArray(wall.origin);
      this.orderObject(record.object, record.order);
      this.group.add(record.object);
      record.dispose = () => {
        fillGeometry.dispose();
        (record.fill!.material as THREE.Material).dispose();
        geometry.dispose();
        material.dispose();
      };
      this.mask.invalidate();
    } else if (feature.kind === 'curve') {
      const material = new LineMaterial({
        color: new THREE.Color(feature.style.color).convertSRGBToLinear(),
        linewidth: feature.style.width,
        worldUnits: feature.style.widthUnit === 'blocks',
        transparent: true,
        opacity: feature.style.opacity,
        depthTest: true,
        depthWrite: feature.style.opacity === 1,
        alphaToCoverage: true,
      });
      const geometry = new LineGeometry();
      record.object = new Line2(geometry, material);
      record.object.position.fromArray(feature.nodes[0].anchor);
      record.object.frustumCulled = false;
      record.curve = { material, positions: [], capped: false };
      record.dispose = () => {
        (record.object as Line2).geometry.dispose();
        material.dispose();
      };
      this.orderObject(record.object, record.order);
      this.group.add(record.object);
    } else {
      const item = this.media.get(`${feature.assetId}/${feature.versionId}`);
      if (!item) throw new Error('unknown pinned media version');
      const lease = this.pool.acquire(`${item.version.digest}:${item.version.mediaType}:decode-v1`, (signal) =>
        (this.dependencies.media ?? loadOverlayMedia)(item, signal, renderer.capabilities.maxTextureSize),
      );
      record.lease = lease;
      lease.promise
        .then((resource) => {
          if (this.disposed || record.lease !== lease) return;
          const object = new THREE.Group();
          object.position.fromArray(feature.position);
          object.rotation.set(...feature.rotation, 'XYZ');
          object.scale.fromArray(feature.scale);
          object.add(resource.instantiate(feature));
          this.orderObject(object, record.order);
          record.object = object;
          this.group.add(object);
        })
        .catch((error) => {
          if (record.lease !== lease || this.disposed) return;
          lease.release();
          record.lease = undefined;
          record.retryAt = performance.now() + RETRY_MS;
          if (!(error instanceof DOMException && error.name === 'AbortError')) this.issue(record.key, error);
        });
    }
  }
  private sample(record: RecordBase, frame: OverlayFrame) {
    const feature = record.feature as CurveFeature,
      line = record.object as Line2;
    try {
      const sampled = sampleCurve(feature, {
        projection: { matrix: this.matrix.elements, width: frame.width, height: frame.height },
        tolerance: OVERLAY_LIMITS.curveToleranceCssPixels,
        maxDepth: OVERLAY_LIMITS.curveDepth,
        maxPoints: Math.min(
          OVERLAY_LIMITS.curvePointsPerFeature,
          OVERLAY_LIMITS.curvePointsTotal - this.curvePoints + record.curve!.positions.length / 3,
        ),
      });
      record.curve!.capped = sampled.capped;
      const origin = feature.nodes[0].anchor,
        positions = sampled.points.flatMap((point) => point.map((v, i) => v - origin[i]));
      const previous = record.curve!.positions;
      if (previous.length !== positions.length || positions.some((v, i) => v !== previous[i])) {
        const geometry = new LineGeometry();
        geometry.setPositions(positions);
        line.geometry.dispose();
        line.geometry = geometry;
        this.curvePoints += (positions.length - previous.length) / 3;
        record.curve!.positions = positions;
      }
      record.curve!.material.resolution.set(frame.width, frame.height);
    } catch (error) {
      this.issue(record.key, error);
      this.release(record);
      record.retryAt = frame.now + RETRY_MS;
    }
  }
  private issue(key: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (this.issues.get(key) !== message) log('warn', 'overlay', message, { feature: key });
    this.issues.set(key, message);
  }
  private release(record: RecordBase) {
    if (record.curve) this.curvePoints -= record.curve.positions.length / 3;
    record.dispose?.();
    record.dispose = undefined;
    if (record.object) {
      this.group.remove(record.object);
      record.object = undefined;
    }
    if (record.fill) {
      this.mask.scene.remove(record.fill);
      this.mask.invalidate();
    }
    record.fill = undefined;
    record.curve = undefined;
    record.lease?.release();
    record.lease = undefined;
  }
  private clear() {
    for (const record of this.records.values()) this.release(record);
    this.records.clear();
    this.media.clear();
    this.mask.dispose();
    this.issues.clear();
    this.lights.visible = false;
  }
  diagnosticSnapshot(): OverlayDiagnosticSnapshot {
    const resources = this.pool.snapshot();
    return {
      mapId: this.mapId,
      dimension: this.dimension,
      enabled: this.enabled,
      loading: this.loading,
      sourceStatus: this.sourceStatus,
      features: this.records.size,
      active: [...this.records.values()].filter((record) => record.object || record.fill || record.lease).length,
      suppressed: this.suppressed,
      versions: resources.versions,
      pending: resources.pending,
      resourceBytes: resources.bytes,
      maskBytes: this.mask.bytes,
      maskLimited: this.mask.layout?.limited ?? false,
      samplingLimited: this.samplingLimited,
      curvePoints: this.curvePoints,
      errors: [...this.issues].slice(0, 20).map(([feature, message]) => ({ feature, message })),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.abort?.abort();
    this.clear();
    this.pool.dispose();
    this.scene.remove(this.group, this.lights);
  }
}
