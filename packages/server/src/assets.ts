import fs from 'node:fs/promises';
import path from 'node:path';
import { AssetBundle, normalizeId } from '@mcr/core';
import { config } from './config.js';

async function walkJson(dir: string, cb: (rel: string, file: string) => void, rel = ''): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkJson(path.join(dir, e.name), cb, r);
    else if (e.name.endsWith('.json')) cb(r, path.join(dir, e.name));
  }
}

let bundleCache: AssetBundle | null = null;

/** 扫描资源目录，合并所有命名空间的 blockstates 与 models（后加载的目录覆盖先前）。 */
export async function buildAssetBundle(force = false): Promise<AssetBundle> {
  if (bundleCache && !force) return bundleCache;
  const bundle: AssetBundle = { blockstates: {}, models: {} };
  for (const dir of config.assetsDirs) {
    let namespaces: string[] = [];
    try {
      namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { continue; }
    for (const ns of namespaces) {
      await walkJson(path.join(dir, ns, 'blockstates'), (rel, file) => {
        const id = `${ns}:${rel.slice(0, -5)}`;
        void fs.readFile(file, 'utf8').then((s) => { bundle.blockstates[id] = JSON.parse(s); }).catch(() => {});
      });
      await walkJson(path.join(dir, ns, 'models'), (rel, file) => {
        const id = `${ns}:${rel.slice(0, -5)}`;
        void fs.readFile(file, 'utf8').then((s) => { bundle.models[id] = JSON.parse(s); }).catch(() => {});
      });
    }
  }
  // walkJson 的读取是异步排队的，等待一拍让所有 readFile 完成
  await new Promise((r) => setTimeout(r, 500));
  bundleCache = bundle;
  return bundle;
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