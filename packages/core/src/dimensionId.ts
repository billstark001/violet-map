const NAMESPACE_RE = /^[a-z0-9_.-]+$/;
const PATH_SEGMENT_RE = /^[a-z0-9_.-]+$/;

/** Accept Minecraft-style IDs, including custom dimension paths with `/`. */
export function isDimensionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length > 2) return false;
  const [namespace, resourcePath] = parts.length === 2 ? parts : ['minecraft', parts[0]];
  return (
    NAMESPACE_RE.test(namespace) &&
    namespace !== '.' &&
    namespace !== '..' &&
    resourcePath.split('/').every((segment) => PATH_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..')
  );
}

export function assertDimensionId(value: string): void {
  if (!isDimensionId(value)) throw new Error('invalid dimension id');
}

const VANILLA_REGION_PATHS: Record<string, readonly string[]> = {
  'minecraft:overworld': ['region', 'dimensions/minecraft/overworld/region'],
  'minecraft:the_nether': ['DIM-1/region', 'dimensions/minecraft/the_nether/region'],
  'minecraft:the_end': ['DIM1/region', 'dimensions/minecraft/the_end/region'],
};

export const VANILLA_DIMENSION_IDS = Object.freeze(Object.keys(VANILLA_REGION_PATHS));

/** Relative terrain directories in lookup order, covering legacy vanilla and
 * modern/custom dimension layouts. Reject invalid IDs before joining paths. */
export function dimensionRegionPaths(dimension: string): readonly string[] {
  assertDimensionId(dimension);
  const vanilla = Object.hasOwn(VANILLA_REGION_PATHS, dimension) ? VANILLA_REGION_PATHS[dimension] : undefined;
  if (vanilla) return [...vanilla];
  const [namespace, resourcePath] = dimension.includes(':') ? dimension.split(':') : ['minecraft', dimension];
  return [`dimensions/${namespace}/${resourcePath}/region`];
}
