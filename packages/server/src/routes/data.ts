import { resourceFailure } from '../resourceErrors.js';
import { artifactResponse } from '../resourceHttp.js';
import type { RouteContext } from './context.js';

export function mountData({ app, resources }: RouteContext) {
  for (const name of ['blocks', 'biomes', 'dimensions'] as const)
    app.get(`/api/data/${name}`, async (c) => {
      try {
        const body = await resources.businessResource({ kind: 'game-data', name });
        return body ? artifactResponse(c, body.artifact, body.read) : c.json({ error: 'data not found' }, 404);
      } catch (error) {
        return resourceFailure(error as Error, c);
      }
    });
}
