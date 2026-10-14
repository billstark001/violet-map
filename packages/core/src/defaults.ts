export const defaultDataUrl = (name: 'biomes.json' | 'dimensions.json' | 'block-overrides.json') =>
  new URL(`../data-defaults/${name}`, import.meta.url);
