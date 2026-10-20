import type { AssetBundle, BlockInfoMap, BlockModelJson } from './assets.js';
import { normalizeId } from './resourceId.js';

export function collectTextureIds(bundle: AssetBundle, blockInfo: BlockInfoMap): string[] {
  const ids = new Set<string>();
  const models = new Set<string>();
  const seenModels = new Set<string>();
  const add = (v: unknown) => {
    if (v && typeof v === 'object') v = (v as { sprite?: unknown }).sprite;
    if (typeof v !== 'string') return;
    if (!v.startsWith('#')) ids.add(normalizeId(v));
  };
  const addModel = (v: unknown) => {
    if (v && typeof v === 'object') v = (v as { model?: unknown }).model;
    if (typeof v === 'string') models.add(normalizeId(v));
  };
  const collectBlockstateModels = (bs: any) => {
    if (bs?.variants) {
      for (const value of Object.values<any>(bs.variants)) {
        if (Array.isArray(value)) value.forEach(addModel);
        else addModel(value);
      }
    }
    if (Array.isArray(bs?.multipart)) {
      for (const part of bs.multipart as any[]) {
        const apply = part?.apply;
        if (Array.isArray(apply)) apply.forEach(addModel);
        else addModel(apply);
      }
    }
  };
  for (const bs of Object.values(bundle.blockstates)) collectBlockstateModels(bs);
  const collectRenderer = (definition: unknown) => {
    if (!definition || typeof definition !== 'object') return;
    const renderer = definition as {
      model?: unknown;
      texture?: unknown;
      textureByBlock?: unknown;
      variants?: Record<string, unknown>;
    };
    addModel(renderer.model);
    add(renderer.texture);
    if (renderer.textureByBlock && typeof renderer.textureByBlock === 'object') {
      for (const texture of Object.values(renderer.textureByBlock)) add(texture);
    }
    for (const variant of Object.values(renderer.variants ?? {})) collectRenderer(variant);
  };
  for (const definition of Object.values(bundle.renderers?.blockEntities ?? {})) collectRenderer(definition);
  for (const definition of Object.values(bundle.renderers?.entities ?? {})) collectRenderer(definition);

  const visitModel = (id: string) => {
    if (seenModels.has(id)) return;
    seenModels.add(id);
    const model = bundle.models[id] as BlockModelJson | undefined;
    if (!model) return;
    if (model.textures) for (const v of Object.values(model.textures)) add(v);
    if (typeof model.parent === 'string') visitModel(normalizeId(model.parent));
  };
  for (const id of models) {
    visitModel(id);
  }
  for (const info of Object.values(blockInfo)) {
    if (!info.fluid) continue;
    add(info.fluid.texture);
    add(info.fluid.flowTexture);
  }
  return [...ids];
}
