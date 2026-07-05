import path from 'node:path';

const mcVersion = process.env.MC_VERSION ?? '1.21.4';
const worldStorage = (process.env.WORLD_STORAGE ?? 'osfs').toLowerCase();

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /** 世界目录：<worldsDir>/<world>/region 等 */
  worldsDir: path.resolve(process.env.WORLDS_DIR ?? 'data/worlds'),
  worldStorage: worldStorage === 's3-compatible' ? 's3' : worldStorage,
  s3: {
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'auto',
    bucket: process.env.S3_BUCKET,
    prefix: process.env.S3_PREFIX ?? '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  },
  adminTokens: process.env.ADMIN_TOKENS ?? 'dev-admin-token:admin,dev-ci-token:ci',
  /** 资源目录列表（后者覆盖前者），每个目录下为 <namespace>/blockstates|models|textures */
  assetsDirs: (process.env.ASSETS_DIRS ?? 'data/assets').split(',').map((p) => path.resolve(p.trim())),
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  mcVersion,
  mcDataVersion: process.env.MC_DATA_VERSION ?? mcVersion,
};
