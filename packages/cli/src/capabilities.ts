import { readFileSync } from 'node:fs';

const entries = {
  '@violet-map/resources/top-map': () => import('@violet-map/resources/top-map'),
  '@violet-map/resources/asset-digest': () => import('@violet-map/resources/asset-digest'),
  '@violet-map/resources/world-chunks': () => import('@violet-map/resources/world-chunks'),
  '@violet-map/resources/game-data': () => import('@violet-map/resources/game-data'),
  '@violet-map/resources/asset-pack': () => import('@violet-map/resources/asset-pack'),
  '@violet-map/resources/top-map-bake': () => import('@violet-map/resources/top-map-bake'),
  '@violet-map/resources': () => import('@violet-map/resources'),
  '@violet-map/render': () => import('@violet-map/render'),
  '@violet-map/render/top-map/sample': () => import('@violet-map/render/top-map/sample'),
  '@violet-map/storage': () => import('@violet-map/storage'),
  '@violet-map/storage/local': () => import('@violet-map/storage/local'),
  '@violet-map/storage/s3': () => import('@violet-map/storage/s3'),
  '@violet-map/storage/server': () => import('@violet-map/storage/server'),
  '@violet-map/storage/factory': () => import('@violet-map/storage/factory'),
  '@violet-map/server/configuration': () => import('@violet-map/server/configuration'),
  '@violet-map/server/services': () => import('@violet-map/server/services'),
  '@violet-map/server/admin': () => import('@violet-map/server/admin'),
};

export async function loadCapability<K extends keyof typeof entries>(
  entry: K,
): Promise<Awaited<ReturnType<(typeof entries)[K]>>> {
  try {
    import.meta.resolve(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    const name = entry.split('/').slice(0, 2).join('/');
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    throw new Error(
      name +
        ' is required: this command requires ' +
        name +
        ` installed alongside @violet-map/cli (compatible ^${version}). Install with npm install ` +
        name +
        `@^${version} in the same npm project as @violet-map/cli.`,
    );
  }
  return (await entries[entry]()) as Awaited<ReturnType<(typeof entries)[K]>>;
}
