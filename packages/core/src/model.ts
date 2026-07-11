import {
  AssetBundle, BlockModelJson, BlockStateRef, BlockStateVariantJson, Direction, ModelElementJson, normalizeId,
} from './types.js';

export interface BakedQuad {
  /** 4 顶点 × xyz，单位为方块（0..1，可越界）。 */
  positions: Float32Array;
  /** 4 顶点 × uv，按 `uvScale` 指定的纹理像素网格计。 */
  uvs: Float32Array;
  /** Source texture dimensions used to normalize `uvs` into the atlas. */
  uvScale: [number, number];
  texture: string;
  cullFace: Direction | null;
  face: Direction;
  tintIndex: number;
  shade: boolean;
  ao: boolean;
}
interface WeightedQuads { weight: number; quads: BakedQuad[] }

export const MISSING_TEXTURE = '__missing__';

type Vec3 = [number, number, number];

const FACE_CORNERS: Record<Direction, (f: Vec3, t: Vec3) => Vec3[]> = {
  up:    (f, t) => [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]],
  down:  (f, t) => [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [t[0], f[1], f[2]], [f[0], f[1], f[2]]],
  north: (f, t) => [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [f[0], f[1], f[2]], [t[0], f[1], f[2]]],
  south: (f, t) => [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]],
  west:  (f, t) => [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [f[0], f[1], t[2]], [f[0], f[1], f[2]]],
  east:  (f, t) => [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]]],
};
const DEFAULT_UV: Record<Direction, (f: Vec3, t: Vec3) => [number, number, number, number]> = {
  down:  (f, t) => [f[0], 16 - t[2], t[0], 16 - f[2]],
  up:    (f, t) => [f[0], f[2], t[0], t[2]],
  north: (f, t) => [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]],
  south: (f, t) => [f[0], 16 - t[1], t[0], 16 - f[1]],
  west:  (f, t) => [f[2], 16 - t[1], t[2], 16 - f[1]],
  east:  (f, t) => [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]],
};
// 变体旋转对方向的映射（与原版四元数 -angle 约定一致）
const ROT_X: Record<Direction, Direction> = { up: 'north', north: 'down', down: 'south', south: 'up', east: 'east', west: 'west' };
const ROT_Y: Record<Direction, Direction> = { north: 'east', east: 'south', south: 'west', west: 'north', up: 'up', down: 'down' };

function rotateDir(dir: Direction, xSteps: number, ySteps: number): Direction {
  let d = dir;
  for (let i = 0; i < xSteps; i++) d = ROT_X[d];
  for (let i = 0; i < ySteps; i++) d = ROT_Y[d];
  return d;
}
function rotXStep(v: Vec3): Vec3 { return [v[0], v[2], 16 - v[1]]; }
function rotYStep(v: Vec3): Vec3 { return [16 - v[2], v[1], v[0]]; }

function boundsOf(verts: Vec3[]): { f: Vec3; t: Vec3 } {
  const f: Vec3 = [Infinity, Infinity, Infinity];
  const t: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let i = 0; i < 3; i++) {
      f[i] = Math.min(f[i], v[i]);
      t[i] = Math.max(t[i], v[i]);
    }
  }
  return { f, t };
}

function cornerIndex(vertex: Vec3, corners: Vec3[]): number {
  const EPS = 1e-4;
  return corners.findIndex((corner) => Math.abs(vertex[0] - corner[0]) < EPS
    && Math.abs(vertex[1] - corner[1]) < EPS
    && Math.abs(vertex[2] - corner[2]) < EPS);
}

function rotateElementVertex(v: Vec3, rot: NonNullable<ModelElementJson['rotation']>): Vec3 {
  const rad = (rot.angle * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const [ox, oy, oz] = rot.origin;
  let x = v[0] - ox, y = v[1] - oy, z = v[2] - oz;
  let nx = x, ny = y, nz = z;
  if (rot.axis === 'x') { ny = y * c - z * s; nz = y * s + z * c; }
  else if (rot.axis === 'y') { nx = x * c + z * s; nz = -x * s + z * c; }
  else { nx = x * c - y * s; ny = x * s + y * c; }
  if (rot.rescale) {
    const f = 1 / Math.abs(c);
    if (rot.axis === 'x') { ny *= f; nz *= f; }
    else if (rot.axis === 'y') { nx *= f; nz *= f; }
    else { nx *= f; ny *= f; }
  }
  return [nx + ox, ny + oy, nz + oz];
}

function normalDir(verts: Vec3[]): Direction {
  const a = [verts[1][0] - verts[0][0], verts[1][1] - verts[0][1], verts[1][2] - verts[0][2]];
  const b = [verts[3][0] - verts[0][0], verts[3][1] - verts[0][1], verts[3][2] - verts[0][2]];
  const n = [-(a[1] * b[2] - a[2] * b[1]), -(a[2] * b[0] - a[0] * b[2]), -(a[0] * b[1] - a[1] * b[0])];
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return n[1] >= 0 ? 'up' : 'down';
  if (ax >= az) return n[0] >= 0 ? 'east' : 'west';
  return n[2] >= 0 ? 'south' : 'north';
}

function stateKey(state: BlockStateRef): string {
  const keys = Object.keys(state.properties).sort();
  return `${state.name}[${keys.map((k) => `${k}=${state.properties[k]}`).join(',')}]`;
}

function matchVariantKey(key: string, props: Record<string, string>): boolean {
  if (key === '') return true;
  return key.split(',').every((pair) => {
    const [k, v] = pair.split('=');
    return props[k] === v;
  });
}
function matchCondition(cond: any, props: Record<string, string>): boolean {
  if (cond.OR) return (cond.OR as any[]).some((c) => matchCondition(c, props));
  if (cond.AND) return (cond.AND as any[]).every((c) => matchCondition(c, props));
  return Object.entries(cond).every(([k, v]) => String(v).split('|').includes(props[k]));
}

function textureRef(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const sprite = (value as { sprite?: unknown }).sprite;
    if (typeof sprite === 'string') return sprite;
  }
  return null;
}

const MISSING_CUBE_MODEL: BlockModelJson = {
  elements: [{
    from: [0, 0, 0], to: [16, 16, 16],
    faces: Object.fromEntries((['down', 'up', 'north', 'south', 'west', 'east'] as Direction[])
      .map((d) => [d, { texture: MISSING_TEXTURE, cullface: d }])),
  }],
};

/** 将 blockstate + 模型 JSON 烘焙为四边形列表，带缓存。 */
export class ModelBaker {
  private byRef = new WeakMap<BlockStateRef, WeightedQuads[]>();
  private byKey = new Map<string, WeightedQuads[]>();
  private variantCache = new Map<string, BakedQuad[]>();

  constructor(private bundle: AssetBundle) {}

  getQuads(state: BlockStateRef, seed: number): BakedQuad[] {
    let variants = this.byRef.get(state);
    if (!variants) {
      const key = stateKey(state);
      variants = this.byKey.get(key);
      if (!variants) {
        variants = this.build(state);
        this.byKey.set(key, variants);
      }
      this.byRef.set(state, variants);
    }
    if (variants.length === 1) return variants[0].quads;
    let total = 0;
    for (const v of variants) total += v.weight;
    let r = seed % total;
    for (const v of variants) { r -= v.weight; if (r < 0) return v.quads; }
    return variants[0].quads;
  }

  /** Bake a resource-registered block-entity/entity model directly. These use
   * the exact same Java model JSON dialect as ordinary block models. */
  getModelQuads(model: string, rotationY = 0, rotationX = 0, uvlock = false): BakedQuad[] {
    return this.bake(normalizeId(model), ((rotationX / 90) & 3), ((rotationY / 90) & 3), uvlock);
  }

  private build(state: BlockStateRef): WeightedQuads[] {
    const bs: any = this.bundle.blockstates[state.name];
    if (!bs) return [{ weight: 1, quads: this.bakeVariant({ model: MISSING_TEXTURE }) }];
    if (bs.variants) {
      for (const [key, value] of Object.entries<any>(bs.variants)) {
        if (matchVariantKey(key, state.properties)) {
          const list = Array.isArray(value) ? value : [value];
          return list.map((v: any) => ({ weight: v.weight ?? 1, quads: this.bakeVariant(v) }));
        }
      }
      return [{ weight: 1, quads: [] }];
    }
    if (bs.multipart) {
      const quads: BakedQuad[] = [];
      for (const part of bs.multipart as any[]) {
        if (!part.when || matchCondition(part.when, state.properties)) {
          const list = Array.isArray(part.apply) ? part.apply : [part.apply];
          for (const v of list) quads.push(...this.bakeVariant(v));
        }
      }
      return [{ weight: 1, quads }];
    }
    return [{ weight: 1, quads: [] }];
  }

  private bakeVariant(variant: BlockStateVariantJson): BakedQuad[] {
    const key = `${variant.model}|${variant.x ?? 0}|${variant.y ?? 0}|${variant.uvlock ? 1 : 0}`;
    let baked = this.variantCache.get(key);
    if (!baked) {
      baked = this.bake(variant.model, ((variant.x ?? 0) / 90) & 3, ((variant.y ?? 0) / 90) & 3, !!variant.uvlock);
      this.variantCache.set(key, baked);
    }
    return baked;
  }

  private flatten(name: string): {
    textures: Record<string, string>;
    elements: ModelElementJson[];
    ao: boolean;
    textureSize: [number, number];
  } {
    const textures: Record<string, string> = {};
    let elements: ModelElementJson[] | undefined;
    let ao: boolean | undefined;
    let textureSize: [number, number] | undefined;
    let cur: string | undefined = normalizeId(name);
    for (let depth = 0; cur && depth < 32; depth++) {
      const m: BlockModelJson | undefined = this.bundle.models[cur] ?? this.bundle.models[normalizeId(cur)];
      if (!m) break;
      if (m.textures) {
        for (const [k, v] of Object.entries(m.textures)) {
          const ref = textureRef(v);
          if (!(k in textures) && ref) textures[k] = ref;
        }
      }
      if (!elements && m.elements) elements = m.elements;
      if (ao === undefined && m.ambientocclusion !== undefined) ao = m.ambientocclusion;
      if (!textureSize && Array.isArray(m.texture_size)
        && Number.isFinite(m.texture_size[0]) && Number.isFinite(m.texture_size[1])
        && m.texture_size[0] > 0 && m.texture_size[1] > 0) {
        textureSize = [m.texture_size[0], m.texture_size[1]];
      }
      cur = m.parent ? normalizeId(m.parent) : undefined;
      if (cur?.startsWith('minecraft:builtin/')) break;
    }
    return { textures, elements: elements ?? [], ao: ao ?? true, textureSize: textureSize ?? [16, 16] };
  }

  private resolveTexture(ref: string, textures: Record<string, string>): string {
    let r = !ref.startsWith('#') && textures[ref] ? `#${ref}` : ref;
    for (let i = 0; i < 16 && r.startsWith('#'); i++) r = textures[r.slice(1)] ?? MISSING_TEXTURE;
    if (r.startsWith('#')) return MISSING_TEXTURE;
    return r === MISSING_TEXTURE ? r : normalizeId(r);
  }

  private bake(modelName: string, rotX: number, rotY: number, uvlock: boolean): BakedQuad[] {
    const isMissing = modelName === MISSING_TEXTURE;
    const { textures, elements, ao, textureSize } = isMissing
      ? { textures: {}, elements: MISSING_CUBE_MODEL.elements!, ao: true, textureSize: [16, 16] as [number, number] }
      : this.flatten(modelName);
    const quads: BakedQuad[] = [];
    for (const el of elements) {
      const f = el.from, t = el.to;
      for (const [dirStr, face] of Object.entries(el.faces ?? {})) {
        if (!face) continue;
        const dir = dirStr as Direction;
        let verts = FACE_CORNERS[dir](f, t);
        let uv = face.uv ?? DEFAULT_UV[dir](f, t);
        let uvCorners: [number, number][] = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
        const steps = (((face.rotation ?? 0) / 90) & 3);
        if (steps) uvCorners = uvCorners.map((_, i) => uvCorners[(i + steps) % 4]);
        if (el.rotation) verts = verts.map((v) => rotateElementVertex(v, el.rotation!));
        for (let i = 0; i < rotX; i++) verts = verts.map(rotXStep);
        for (let i = 0; i < rotY; i++) verts = verts.map(rotYStep);
        const bakedFace = normalDir(verts);
        if (uvlock && (rotX || rotY)) {
          const b = boundsOf(verts);
          uv = DEFAULT_UV[bakedFace](b.f, b.t);
          let canonicalUvs: [number, number][] = [
            [uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]],
          ];
          if (steps) canonicalUvs = canonicalUvs.map((_, i) => canonicalUvs[(i + steps) % 4]);
          // The rotated vertex order is generally not the canonical order of
          // the new face. Assigning canonical UVs by array position rotates a
          // half-width stair rectangle onto its long edge and stretches it to
          // 200%. Match each rotated vertex to the corresponding canonical
          // corner instead, which is the discrete form of vanilla UV locking.
          const canonicalVerts = FACE_CORNERS[bakedFace](b.f, b.t);
          uvCorners = verts.map((vertex, i) => {
            const corner = cornerIndex(vertex, canonicalVerts);
            return canonicalUvs[corner >= 0 ? corner : i];
          });
        }
        const positions = new Float32Array(12);
        for (let i = 0; i < 4; i++) {
          positions[i * 3] = verts[i][0] / 16;
          positions[i * 3 + 1] = verts[i][1] / 16;
          positions[i * 3 + 2] = verts[i][2] / 16;
        }
        const uvs = new Float32Array(8);
        for (let i = 0; i < 4; i++) { uvs[i * 2] = uvCorners[i][0]; uvs[i * 2 + 1] = uvCorners[i][1]; }
        quads.push({
          positions, uvs, uvScale: textureSize,
          texture: this.resolveTexture(face.texture, textures),
          cullFace: face.cullface ? rotateDir(face.cullface, rotX, rotY) : null,
          face: bakedFace,
          tintIndex: face.tintindex ?? -1,
          shade: el.shade ?? true,
          ao,
        });
      }
    }
    return quads;
  }
}
