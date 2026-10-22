import type { PreparedTopMapTile } from '@violet-map/core/formats/top-map';

export interface TopMapTileDisplay {
  step: number;
  coverageKey: string;
  visible: boolean;
  meshBytes: number;
}

/** Display feedback is observation, never an alternative source of demand. */
export interface TopMapDisplay {
  setEnabled(enabled: boolean): void;
  add(key: string, data: PreparedTopMapTile): void;
  update(key: string, step: number, coverageKey: string, mask: Uint8Array | undefined): void;
  setWanted(wanted: ReadonlySet<string>): void;
  snapshot(key: string): TopMapTileDisplay;
  remove(key: string): void;
  clear(): void;
  dispose(): void;
}
