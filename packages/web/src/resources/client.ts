import {
  canonicalJson,
  parseResolvedResource,
  parseResourceSelector,
  parseResourceViewHead,
  ResourceError,
  type ResolvedResource,
  type ResourceResolveBatch,
  type ResourceSelector,
  type ResourceViewHead,
} from '@violet-map/core/resources';
import { apiFetch, apiUrl } from '../runtime';

interface Current {
  head: ResourceViewHead;
  etag?: string;
  receivedAt: number;
}

function sameGeneration(a: ResourceViewHead, b: ResourceViewHead) {
  return (
    a.mode === b.mode &&
    a.renderRoot === b.renderRoot &&
    a.generation === b.generation &&
    (a.mode !== 'public' || (b.mode === 'public' && a.publicationId === b.publicationId && a.viewId === b.viewId))
  );
}

export class ResourceClient {
  private context = '';
  private epoch = 0;
  private ensureContext() {
    const next = apiUrl('api/resources');
    if (next !== this.context) {
      this.context = next;
      this.epoch++;
      this.heads.clear();
      this.pending.clear();
    }
  }
  private readonly heads = new Map<string, Current>();
  private readonly pending = new Map<string, Promise<ResourceViewHead>>();
  private readonly subscribers = new Set<(previous: ResourceViewHead, current: ResourceViewHead) => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private refreshTask?: Promise<void>;
  lastError: unknown;
  current(world = '') {
    this.ensureContext();
    return this.heads.get(world)?.head;
  }
  private readonly visibility = () => {
    if (document.visibilityState === 'visible') this.schedule();
    else if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  };
  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility);
  }
  subscribe(listener: (previous: ResourceViewHead, current: ResourceViewHead) => void) {
    this.subscribers.add(listener);
    this.schedule();
    return () => {
      this.subscribers.delete(listener);
      if (!this.subscribers.size && this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
    };
  }
  private schedule() {
    if (
      this.timer ||
      !this.subscribers.size ||
      typeof document === 'undefined' ||
      document.visibilityState === 'hidden'
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh()
        .then(
          () => {
            this.lastError = undefined;
          },
          (error) => {
            this.lastError = error;
          },
        )
        .finally(() => this.schedule());
    }, 15000);
  }
  private notify(previous: Current | undefined, current: Current) {
    if (
      previous &&
      (current.head.viewId !== previous.head.viewId || current.head.renderRoot !== previous.head.renderRoot)
    )
      for (const listener of this.subscribers) listener(previous.head, current.head);
  }
  private async readHead(world: string, known?: Current, signal?: AbortSignal): Promise<Current> {
    const response = await apiFetch(
      `api/resources/views/current${world ? '?world=' + encodeURIComponent(world) : ''}`,
      {
        headers: known?.etag ? { 'if-none-match': known.etag } : {},
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]),
        cache: 'no-cache',
      },
    );
    if (response.status === 304 && known) return { ...known, receivedAt: Date.now() };
    if (!response.ok) throw await this.error(response);
    return {
      head: parseResourceViewHead(await response.json()),
      etag: response.headers.get('etag') ?? undefined,
      receivedAt: Date.now(),
    };
  }
  async refresh() {
    this.ensureContext();
    if (this.refreshTask) return this.refreshTask;
    const epoch = this.epoch;
    const previous = new Map(this.heads);
    const task = (async () => {
      const updates = await Promise.all(
        [...previous].map(async ([world, known]) => [world, await this.readHead(world, known)] as const),
      );
      this.ensureContext();
      if (epoch !== this.epoch)
        throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource delivery context changed', true);
      const first = updates[0]?.[1].head;
      for (const [, { head }] of updates)
        if (!sameGeneration(head, first!))
          throw new ResourceError(
            'RESOURCE_VIEW_EXPIRED',
            'resource heads changed while refreshing; retry the complete view',
            true,
          );
      // Commit every world and the render root before notifying any consumer.
      // A failed request leaves the previous complete set visible.
      for (const [world, current] of updates) this.heads.set(world, current);
      for (const [world, current] of updates) this.notify(previous.get(world), current);
    })();
    this.refreshTask = task;
    try {
      await task;
    } finally {
      if (this.refreshTask === task) this.refreshTask = undefined;
    }
  }
  async head(world = '', refresh = false, signal?: AbortSignal): Promise<ResourceViewHead> {
    this.ensureContext();
    signal?.throwIfAborted();
    if (refresh && this.heads.has(world)) {
      await this.refresh();
      signal?.throwIfAborted();
      return this.heads.get(world)!.head;
    }
    if (this.refreshTask) await this.refreshTask;
    const epoch = this.epoch;
    const known = this.heads.get(world);
    if (known && Date.now() - known.receivedAt < 86400000) return known.head;
    const inflight = this.pending.get(world);
    if (inflight) return inflight;
    if (this.heads.size + this.pending.size >= 16 && !known)
      throw new ResourceError('RESOURCE_BUSY', 'too many active world resource views', true);
    const promise = (async () => {
      const current = await this.readHead(world, known, signal);
      this.ensureContext();
      if (epoch !== this.epoch)
        throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource delivery context changed', true);
      for (const [otherWorld, other] of this.heads)
        if (otherWorld !== world && !sameGeneration(current.head, other.head))
          throw new ResourceError(
            'RESOURCE_VIEW_EXPIRED',
            'new world and existing resources belong to different generations; refresh the complete view',
            true,
          );
      this.heads.set(world, current);
      this.notify(known, current);
      return current.head;
    })();
    this.pending.set(world, promise);
    try {
      return await promise;
    } finally {
      if (this.pending.get(world) === promise) this.pending.delete(world);
    }
  }
  assertCurrent(head: ResourceViewHead, world = '') {
    if (this.current(world)?.viewId !== head.viewId)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'discarded bytes from an old resource view', true);
    const root = this.heads.get('')?.head;
    if (root && !sameGeneration(head, root))
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'world and render root belong to different generations', true);
  }
  private async error(response: Response) {
    let body: { code?: string; message?: string; retryable?: boolean };
    try {
      body = await response.json();
    } catch {
      throw new ResourceError(
        'RESOURCE_BACKEND_UNAVAILABLE',
        `resource API HTTP ${response.status}: invalid error document`,
        response.status >= 500,
      );
    }
    return new ResourceError(
      (body.code ?? 'RESOURCE_BACKEND_UNAVAILABLE') as import('@violet-map/core/resources').ResourceErrorCode,
      body.message ?? `resource API HTTP ${response.status}`,
      body.retryable === true,
    );
  }
  async resolve(
    selectors: ResourceSelector[],
    world = '',
    signal?: AbortSignal,
  ): Promise<{ head: ResourceViewHead; resources: ResolvedResource[] }> {
    const head = await this.head(world, false, signal);
    const response = await apiFetch('api/resources/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ viewId: head.viewId, selectors: selectors.map(parseResourceSelector) }),
      signal,
    });
    if (!response.ok) {
      const error = await this.error(response);
      if (error.code === 'RESOURCE_VIEW_EXPIRED') await this.head(world, true, signal);
      throw error;
    }
    const batch = (await response.json()) as ResourceResolveBatch;
    if (
      batch.viewId !== head.viewId ||
      !Array.isArray(batch.resources) ||
      batch.resources.length !== selectors.length ||
      !Number.isSafeInteger(batch.validUntil) ||
      batch.validUntil <= Date.now()
    )
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid resource resolve batch');
    this.assertCurrent(head, world);
    batch.resources = batch.resources.map(parseResolvedResource);
    if (head.mode === 'public')
      for (const result of batch.resources) {
        const refs =
          'resource' in result ? [result.resource] : 'manifest' in result ? [result.manifest, result.image] : [];
        if (refs.some((ref) => ref.url.startsWith('/')))
          throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'public resources require an explicit absolute URL');
      }
    batch.resources.forEach((result, index) => {
      if (canonicalJson(parseResourceSelector(result.selector)) !== canonicalJson(selectors[index]))
        throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'resource selector order mismatch');
    });
    return { head, resources: batch.resources };
  }
}

export const resourceClient = new ResourceClient();
