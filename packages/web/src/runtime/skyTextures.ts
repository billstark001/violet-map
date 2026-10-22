import { loadTextureImage } from '../atlas';
import { loadResource } from '../resources/load';
import { ResourceError } from '@violet-map/core/resources';

export interface SkyTextureImage {
  id: string;
  image: HTMLImageElement;
  layout: 'single' | 'moon-sheet';
}

export interface SkyTextureImages {
  sun: SkyTextureImage | null;
  moon: SkyTextureImage | null;
}

/** Supported Minecraft texture layouts. Only explicit source absence selects
 * the next layout; a transport/verification failure never substitutes another.
 */
async function loadCelestial(
  candidates: readonly { id: string; layout: SkyTextureImage['layout'] }[],
  signal: AbortSignal,
): Promise<SkyTextureImage | null> {
  for (const candidate of candidates) {
    const image = await loadResource((lifetime) => loadTextureImage(candidate.id, lifetime), signal);
    if (!image) continue;
    if (candidate.layout === 'moon-sheet' && (image.width < 4 || image.height < 2))
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'moon phase sheet has no complete frame');
    return { ...candidate, image };
  }
  return null;
}

export async function loadSkyTextures(signal: AbortSignal): Promise<SkyTextureImages> {
  const [sun, moon] = await Promise.all([
    loadCelestial(
      [
        { id: 'minecraft:environment/celestial/sun', layout: 'single' },
        { id: 'minecraft:environment/sun', layout: 'single' },
      ],
      signal,
    ),
    loadCelestial(
      [
        { id: 'minecraft:environment/celestial/moon/full_moon', layout: 'single' },
        { id: 'minecraft:environment/moon_phases', layout: 'moon-sheet' },
      ],
      signal,
    ),
  ]);
  return { sun, moon };
}
