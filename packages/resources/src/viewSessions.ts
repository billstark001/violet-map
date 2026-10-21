import { isWorldName } from '@violet-map/core/domain';
import {
  canonicalJson,
  ResourceError,
  type PublicationManifest,
  type ResourceViewHead,
  type PublicationEntry,
} from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';
import { randomUUID } from 'node:crypto';
import type { ResourceEngineConfig, ResourceEngineMounts } from './engineTypes.js';
import type { InvalidationCoordinator } from './invalidation.js';
import type { PublicationStore } from './publication.js';
import { type SnapshotGate, type SnapshotToken } from './snapshotGate.js';
import { resourceJsonBytes } from './engineSupport.js';

export interface View {
  head: ResourceViewHead;
  createdAt: number;
  expiresAt?: number;
  world?: string;
  publication?: PublicationManifest;
}

/** Owns view identities and bounded retention; bodies remain owned by the repository. */
export class ResourceViewSessions {
  private readonly bootId = randomUUID();
  private readonly views = new Map<string, View>();
  constructor(
    private readonly config: ResourceEngineConfig,
    private readonly mounts: ResourceEngineMounts,
    private readonly coordinator: InvalidationCoordinator,
    private readonly store: PublicationStore | undefined,
    private readonly sourceGate: SnapshotGate,
    private readonly renderRoot: (token?: SnapshotToken) => Promise<{ digest: string; entries: PublicationEntry[] }>,
    private readonly discard: (entry: PublicationEntry) => void,
  ) {}
  head(world?: string) {
    return this.config.resources.delivery.mode === 'public'
      ? this.snapshotHead(world)
      : this.sourceGate.read((token) => this.snapshotHead(world, token));
  }
  close() {
    this.views.clear();
  }
  async sourceScope(world?: string): Promise<string> {
    if (!world) return sha256(canonicalJson({ scope: this.config.resources.source.scope }));
    if (!isWorldName(world)) throw new TypeError('invalid world');
    const identity = await this.mounts.worlds?.read(`${world}/.violet-map/identity.json`);
    let archive: string | null = null;
    if (identity) {
      const value = JSON.parse(new TextDecoder().decode(identity));
      if (value.schema !== 1 || typeof value.id !== 'string')
        throw new ResourceError('SOURCE_REVISION_UNAVAILABLE', 'invalid world archive identity');
      archive = value.id;
    }
    return sha256(
      canonicalJson({
        scope: this.config.resources.source.scope,
        world,
        archive,
        locator: archive ? null : this.config.sourceIdentity,
      }),
    );
  }

  private async snapshotHead(world: string | undefined, token?: SnapshotToken): Promise<ResourceViewHead> {
    if (!this.config.resources.roles.includes('serve') && !this.config.resources.roles.includes('publish'))
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'resource role disabled');
    if (this.config.resources.delivery.mode === 'public') {
      const head = await this.store?.head();
      if (!head) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'no complete resource publication exists');
      let view = this.views.get(head.publicationId);
      if (!view) {
        const publication = await this.store!.manifest(head);
        view = {
          head: {
            schemaVersion: 1,
            viewId: head.publicationId,
            mode: 'public',
            sourceScope: publication.sourceScope,
            generation: head.revision,
            renderRoot: publication.renderRoot,
            publicationId: head.publicationId,
          },
          publication,
          createdAt: Date.now(),
        };
        this.retainView(head.publicationId, { ...view, publication: undefined });
      }
      if (world) {
        if (!isWorldName(world)) throw new TypeError('invalid world');
        const publication = view.publication ?? (await this.store!.manifest(head));
        return {
          ...view.head,
          sourceScope:
            publication.sourceScopes[world] ??
            (() => {
              throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'world is not part of this publication');
            })(),
        };
      }
      return view.head;
    }
    const root = await this.renderRoot(token);
    for (const entry of root.entries) this.discard(entry);
    const sourceScope = await this.sourceScope(world);
    const viewId = sha256(
      canonicalJson({
        boot: this.bootId,
        sourceScope,
        generation: this.coordinator.generation,
        renderRoot: root.digest,
        session: Math.floor(Date.now() / 86400000),
      }),
    );
    const head: ResourceViewHead = {
      schemaVersion: 1,
      viewId,
      mode: 'server',
      sourceScope,
      generation: this.coordinator.generation,
      renderRoot: root.digest,
    };
    this.retainView(viewId, { head, world, createdAt: Date.now() });
    return head;
  }

  private retainView(id: string, view: View) {
    const existing = this.views.get(id);
    if (existing) {
      existing.expiresAt = Date.now() + this.config.resources.work.handoffMs;
      return;
    }
    view.expiresAt = Date.now() + this.config.resources.work.handoffMs;
    for (const [key, value] of this.views)
      if (Date.now() - value.createdAt > 86400000 || (value.expiresAt ?? 0) < Date.now()) this.views.delete(key);
    const cost = (v: View) => 1024 + (v.publication ? resourceJsonBytes(v.publication).byteLength * 4 : 0);
    const total = [...this.views.values()].reduce((sum, v) => sum + cost(v), 0);
    if (total + cost(view) > this.config.resources.cache.metadataBytes / 8)
      throw new ResourceError('RESOURCE_BUSY', 'active resource views exhaust metadata budget', true);
    this.views.set(id, view);
  }

  async get(viewId: string, materialized = false): Promise<View> {
    let view = this.views.get(viewId);
    if (this.config.resources.delivery.mode === 'public') {
      const retained = await this.store!.retainedHead(viewId);
      if (!retained) throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'publication is no longer retained', true);
      const publication = await this.store!.manifest(retained);
      return {
        head: {
          schemaVersion: 1,
          viewId,
          mode: 'public',
          sourceScope: publication.sourceScope,
          generation: retained.revision,
          renderRoot: publication.renderRoot,
          publicationId: viewId,
        },
        createdAt: Date.now(),
        publication,
      };
    }
    if (!view || Date.now() - view.createdAt > 86400000)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource view expired; refresh its head', true);
    if (view.head.mode === 'server' && !materialized && view.head.generation !== this.coordinator.generation)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource source generation changed', true);
    return view;
  }
}
