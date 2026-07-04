import {
  AssetBundle, BlockModelJson, BlockStateRef, Direction, ModelElementJson, normalizeId,
} from './types.js';

export interface BakedQuad {
  /** 4 顶点 × xyz，单位为方块（0..1，可越界）。 */
  positions: Float32Array;
  /** 4 顶点 × uv，0..16 纹理内坐标。 */
  uvs: Float32Array;
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
          const v = Array.isArray(part.apply) ? part.apply[0] : part.apply;
          quads.push(...this.bakeVariant(v));
        }
      }
      return [{ weight: 1, quads }];
    }
    return [{ weight: 1, quads: [] }];
  }

  private bakeVariant(variant: { model: string; x?: number; y?: number }): BakedQuad[] {
    const key = `${variant.model}|${variant.x ?? 0}|${variant.y ?? 0}`;
    let baked = this.variantCache.get(key);
    if (!baked) {
      baked = this.bake(variant.model, ((variant.x ?? 0) / 90) & 3, ((variant.y ?? 0) / 90) & 3);
      this.variantCache.set(key, baked);
    }
    return baked;
  }

  private flatten(name: string): { textures: Record<string, string>; elements: ModelElementJson[]; ao: boolean } {
    const textures: Record<string, string> = {};
    let elements: ModelElementJson[] | undefined;
    let ao: boolean | undefined;
    let cur: string | undefined = normalizeId(name);
    for (let depth = 0; cur && depth < 32; depth++) {
      const m: BlockModelJson | undefined = this.bundle.models[cur] ?? this.bundle.models[normalizeId(cur)];
      if (!m) break;
      if (m.textures) for (const [k, v] of Object.entries(m.textures)) if (!(k in textures)) textures[k] = v;
      if (!elements && m.elements) elements = m.elements;
      if (ao === undefined && m.ambientocclusion !== undefined) ao = m.ambientocclusion;
      cur = m.parent ? normalizeId(m.parent) : undefined;
      if (cur?.startsWith('minecraft:builtin/')) break;
    }
    return { textures, elements: elements ?? [], ao: ao ?? true };
  }

  private resolveTexture(ref: string, textures: Record<string, string>): string {
    let r = ref;
    for (let i = 0; i < 16 && r.startsWith('#'); i++) r = textures[r.slice(1)] ?? MISSING_TEXTURE;
    if (r.startsWith('#')) return MISSING_TEXTURE;
    return r === MISSING_TEXTURE ? r : normalizeId(r);
  }

  private bake(modelName: string, rotX: number, rotY: number): BakedQuad[] {
    const isMissing = modelName === MISSING_TEXTURE;
    const { textures, elements, ao } = isMissing
      ? { textures: {}, elements: MISSING_CUBE_MODEL.elements!, ao: true }
      : this.flatten(modelName);
    const quads: BakedQuad[] = [];
    for (const el of elements) {
      const f = el.from, t = el.to;
      for (const [dirStr, face] of Object.entries(el.faces ?? {})) {
        if (!face) continue;
        const dir = dirStr as Direction;
        let verts = FACE_CORNERS[dir](f, t);
        const uv = face.uv ?? DEFAULT_UV[dir](f, t);
        let uvCorners: [number, number][] = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
        const steps = (((face.rotation ?? 0) / 90) & 3);
        if (steps) uvCorners = uvCorners.map((_, i) => uvCorners[(i + steps) % 4]);
        if (el.rotation) verts = verts.map((v) => rotateElementVertex(v, el.rotation!));
        for (let i = 0; i < rotX; i++) verts = verts.map(rotXStep);
        for (let i = 0; i < rotY; i++) verts = verts.map(rotYStep);
        const positions = new Float32Array(12);
        for (let i = 0; i < 4; i++) {
          positions[i * 3] = verts[i][0] / 16;
          positions[i * 3 + 1] = verts[i][1] / 16;
          positions[i * 3 + 2] = verts[i][2] / 16;
        }
        const uvs = new Float32Array(8);
        for (let i = 0; i < 4; i++) { uvs[i * 2] = uvCorners[i][0]; uvs[i * 2 + 1] = uvCorners[i][1]; }
        quads.push({
          positions, uvs,
          texture: this.resolveTexture(face.texture, textures),
          cullFace: face.cullface ? rotateDir(face.cullface, rotX, rotY) : null,
          face: normalDir(verts),
          tintIndex: face.tintindex ?? -1,
          shade: el.shade ?? true,
          ao,
        });
      }
    }
    return quads;
  }
}