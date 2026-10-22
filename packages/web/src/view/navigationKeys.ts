export const FAST_MOVEMENT_KEYS = ['ControlLeft', 'ControlRight', 'KeyR'] as const;
const horizontal = ['KeyW', 'KeyA', 'KeyS', 'KeyD'] as const;
export const FLY_MOVEMENT_KEYS = [...horizontal, ...FAST_MOVEMENT_KEYS, 'Space', 'ShiftLeft', 'ShiftRight'] as const;
export const TOP_MOVEMENT_KEYS = [
  ...horizontal,
  ...FAST_MOVEMENT_KEYS,
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const;

// Capture navigation only. Escape and unrelated browser/system shortcuts remain available.
export const NAVIGATION_KEYS = [...new Set([...FLY_MOVEMENT_KEYS, ...TOP_MOVEMENT_KEYS])];
