import { LruCache } from '@violet-map/core/cache';
import type { ArtifactRef } from '@violet-map/core/resources';
import { canonicalJson, parseArtifactRef } from '@violet-map/core/resources';
import { byteCapacity } from '../budget.js';
import type { ActionIndex } from '../catalog.js';
import { assertActionKey } from '../catalog.js';

export class MemoryActionIndex implements ActionIndex {
  private readonly entries: LruCache<string, ArtifactRef>;
  constructor(metadataBytes: number) {
    byteCapacity(metadataBytes);
    this.entries = new LruCache({
      maxEntries: Math.floor(metadataBytes / 64),
      maxWeight: metadataBytes,
      weightOf: (ref) => 128 + new TextEncoder().encode(canonicalJson(ref)).byteLength,
    });
  }
  get bytes() {
    return this.entries.weight;
  }
  async get(key: string) {
    assertActionKey(key);
    const ref = this.entries.get(key);
    return ref ? { ...ref } : undefined;
  }
  async set(key: string, ref: ArtifactRef) {
    assertActionKey(key);
    this.entries.set(key, Object.freeze(parseArtifactRef(ref)));
  }
  async delete(key: string) {
    assertActionKey(key);
    this.entries.delete(key);
  }
  close() {
    this.entries.clear();
  }
}
