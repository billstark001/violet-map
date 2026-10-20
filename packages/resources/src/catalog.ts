import type { ArtifactRef } from '@violet-map/core/resources';

export function assertActionKey(key: string): void {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new TypeError('invalid action key');
}

export interface ActionIndex {
  get(key: string): Promise<ArtifactRef | undefined>;
  set(key: string, ref: ArtifactRef): Promise<void>;
  delete(key: string): Promise<void>;
  close(): void;
}
