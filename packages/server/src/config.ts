import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** 世界目录：<worldsDir>/<world>/region 等 */
  worldsDir: path.resolve(process.env.WORLDS_DIR ?? 'data/worlds'),
  /** 资源目录列表（后者覆盖前者），每个目录下为 <namespace>/blockstates|models|textures */
  assetsDirs: (process.env.ASSETS_DIRS ?? 'data/assets').split(',').map((p) => path.resolve(p.trim())),
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  mcVersion: process.env.MC_VERSION ?? '1.20.4',
};