import type { TopClipRange } from './worldGeometry';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export type ViewProjection =
  | { kind: 'perspective'; fovYRadians: number; aspect: number; zoom: number; near: number }
  | { kind: 'orthographic'; left: number; right: number; top: number; bottom: number; zoom: number; near: number };

/** Immutable camera data at a frame boundary. No graphics-engine objects escape the adapter. */
export interface ViewState {
  readonly position: Readonly<Point3>;
  readonly direction: Readonly<Point3>;
  readonly projection: Readonly<ViewProjection>;
  readonly mode: 'perspective' | 'top';
  readonly clip: Readonly<TopClipRange>;
}
