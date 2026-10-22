import {
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
import type { SharedUniforms } from './materials';
import {
  planOverlayAdmission,
  planOverlayFeatures,
  curveSamplingBudget,
  type OverlayCandidate,
} from '../scheduling/overlayPlanner';
import { OVERLAY_ADMISSION_LIMITS, OVERLAY_RETRY_MS } from '../scheduling/overlayPolicy';
import { OverlayMask, createMaskMaterial } from './overlayMask';
import type { OverlayMediaResource } from './overlayMedia';
import type { OverlayMediaLoader } from '../runtime/overlayMediaLoader';
import type { OverlayDisplay, OverlayDisplaySnapshot } from '../runtime/overlayDisplay';
import { OverlayResourcePool, type ResourceLease } from '../resources/overlayPool';

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

export class OverlayScene implements OverlayDisplay {
  readonly group = new THREE.Group();
  private readonly mask: OverlayMask;
  private readonly records = new Map<string, RecordBase>();
  private pool = new OverlayResourcePool<OverlayMediaResource>();
  private media = new Map<string, OverlayMediaReference>();
  private readonly lights = new THREE.Group();
  private readonly hemisphere = new THREE.HemisphereLight(0xffffff, 0x888899, 1);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  private readonly issues = new Map<string, string>();
  private enabled = false;
  private disposed = false;
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
    private readonly loadMedia: OverlayMediaLoader<OverlayMediaResource>,
  ) {
    this.mask = new OverlayMask(shared);
    this.group.name = 'map-overlays';
    scene.add(this.group);
    this.sun.position.set(0.4, 1, 0.25);
    this.lights.add(this.hemisphere, this.sun);
    this.lights.visible = false;
    scene.add(this.lights);
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.group.visible = enabled;
    if (!enabled) {
      this.shared.overlayMaskEnabled.value = 0;
      this.lights.visible = false;
    }
  }

  reset() {
    this.clear();
    this.pool.dispose();
    this.pool = new OverlayResourcePool<OverlayMediaResource>();
  }

  apply(manifest: OverlayManifest) {
    const nextMedia = new Map(
      manifest.media.map((item) => [`${item.version.assetId}/${item.version.versionId}`, item]),
    );
    this.media = nextMedia;
    const wanted = new Set<string>();
    for (const { key, feature, order } of planOverlayFeatures(manifest)) {
      wanted.add(key);
      const existing = this.records.get(key);
      if (existing && JSON.stringify(existing.feature) === JSON.stringify(feature)) {
        existing.order = order;
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
        this.records.set(key, { key, feature, order, bounds });
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
  render(renderer: THREE.WebGLRenderer, frame: OverlayFrame) {
    if (this.disposed) return;
    if (!this.enabled) {
      this.shared.overlayMaskEnabled.value = 0;
      this.lights.visible = false;
      return;
    }
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
    let hasMedia = false,
      maskBounds: { min: [number, number]; max: [number, number] } | null = null;
    const viewBounds = this.topBounds(frame);
    const candidates: OverlayCandidate[] = [];
    for (const record of this.records.values()) {
      const f = record.feature;
      let visible: boolean;
      if (f.kind === 'area' && frame.topView)
        visible =
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
      }
      candidates.push({
        key: record.key,
        feature: f,
        spatiallyVisible: visible,
        retryAt: record.retryAt,
        active: !!(record.object || record.fill || record.lease),
        curvePoints: record.curve ? record.curve.positions.length / 3 : 0,
      });
    }
    const plan = planOverlayAdmission(
      candidates,
      {
        now: frame.now,
        topView: frame.topView,
        projectionChanged: resample,
      },
      OVERLAY_ADMISSION_LIMITS,
    );
    this.suppressed = plan.suppressed;
    for (const key of plan.release) this.release(this.records.get(key)!);
    for (const admission of plan.admitted) {
      const record = this.records.get(admission.key)!;
      const f = record.feature;
      if (admission.activate) {
        try {
          this.activate(record, renderer);
        } catch (error) {
          record.retryAt = frame.now + OVERLAY_RETRY_MS;
          this.issue(record.key, error);
        }
      }
      if (admission.sample && record.object) this.sample(record, frame);
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
        this.loadMedia(item, signal, renderer.capabilities.maxTextureSize),
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
          record.retryAt = performance.now() + OVERLAY_RETRY_MS;
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
        ...curveSamplingBudget(this.curvePoints, record.curve!.positions.length / 3, OVERLAY_ADMISSION_LIMITS),
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
      record.retryAt = frame.now + OVERLAY_RETRY_MS;
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
  diagnosticSnapshot(): OverlayDisplaySnapshot {
    const resources = this.pool.snapshot();
    return {
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
    this.clear();
    this.pool.dispose();
    this.scene.remove(this.group, this.lights);
  }
}
