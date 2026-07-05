import fs from 'node:fs/promises';
import path from 'node:path';
import { AssetBundle, normalizeId } from '@violet-map/core';
import { config } from './config.js';

type JsonEntry = { rel: string; file: string };

async function walkJson(dir: string, entries: JsonEntry[] = [], rel = ''): Promise<JsonEntry[]> {
  let dirents;
  try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return entries; }
  for (const e of dirents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkJson(path.join(dir, e.name), entries, r);
    else if (e.name.endsWith('.json')) entries.push({ rel: r, file: path.join(dir, e.name) });
  }
  return entries;
}

let bundleCache: AssetBundle | null = null;
let bundlePromise: Promise<AssetBundle> | null = null;

/** 扫描资源目录，合并所有命名空间的 blockstates 与 models（后加载的目录覆盖先前）。 */
export async function buildAssetBundle(force = false): Promise<AssetBundle> {
  if (bundleCache && !force) return bundleCache;
  if (!force && bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const bundle: AssetBundle = { blockstates: {}, models: {} };
    for (const dir of config.assetsDirs) {
      let namespaces: string[] = [];
      try {
        namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { continue; }
      for (const ns of namespaces) {
        const bsEntries = await walkJson(path.join(dir, ns, 'blockstates'));
        const modelEntries = await walkJson(path.join(dir, ns, 'models'));
        const allReads: Promise<void>[] = [];
        for (const { rel, file } of bsEntries) {
          const id = `${ns}:${rel.slice(0, -5)}`;
          allReads.push(
            fs.readFile(file, 'utf8').then((s) => { bundle.blockstates[id] = JSON.parse(s); }).catch(() => {}),
          );
        }
        for (const { rel, file } of modelEntries) {
          const id = `${ns}:${rel.slice(0, -5)}`;
          allReads.push(
            fs.readFile(file, 'utf8').then((s) => { bundle.models[id] = JSON.parse(s); }).catch(() => {}),
          );
        }
        await Promise.all(allReads);
      }
    }
    bundleCache = bundle;
    bundlePromise = null;
    return bundle;
  })();
  return bundlePromise;
}

const TEXTURE_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** 纹理 id（如 minecraft:block/stone）到文件路径，后加载目录优先。 */
export async function textureFilePath(id: string): Promise<string | null> {
  const nid = normalizeId(id);
  if (!TEXTURE_ID_RE.test(nid) || nid.includes('..')) return null;
  const [ns, rest] = nid.split(':');
  for (let i = config.assetsDirs.length - 1; i >= 0; i--) {
    const file = path.join(config.assetsDirs[i], ns, 'textures', `${rest}.png`);
    try { await fs.access(file); return file; } catch { /* next */ }
  }
  return null;
}