import { ResourceError } from '@violet-map/core/resources';

/** A coordinator belongs to one configured source scope; no unbounded world-name map. */
export class InvalidationCoordinator {
  private current = 0;
  get generation() {
    return this.current;
  }
  invalidate() {
    return ++this.current;
  }
  assert(generation: number) {
    if (generation !== this.current)
      throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'resource source changed during generation', true);
  }
}
