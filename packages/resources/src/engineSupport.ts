import { canonicalJson } from '@violet-map/core/resources';

export const resourceJsonBytes = (value: unknown) =>
  new TextEncoder().encode(canonicalJson(JSON.parse(JSON.stringify(value))));

export const projectionKey = (world: string, dimension: string) => canonicalJson([world, dimension]);
