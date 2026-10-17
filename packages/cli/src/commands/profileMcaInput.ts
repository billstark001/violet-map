import { resolvePath } from './paths.js';

export interface ProfileOptions {
  region: string;
  limit: number;
  rounds: number;
  centerX: number;
  centerZ: number;
  hasSkyLight: boolean;
  out?: string;
  assetDirs: string[];
  blockInfo?: string;
}

export interface ProfileInput {
  region: string;
  limit?: number;
  rounds?: number;
  center?: string;
  sky?: boolean;
  out?: string;
  assetsDir?: string;
  blockInfo?: string;
}

export function profileOptions(input: ProfileInput): ProfileOptions {
  const center = (input.center ?? '0,0').split(',').map(Number);
  if (center.length !== 2 || !center.every(Number.isFinite)) throw new Error('center must be cx,cz');
  return {
    region: resolvePath(input.region),
    limit: input.limit ?? 64,
    rounds: input.rounds ?? 2,
    centerX: center[0],
    centerZ: center[1],
    hasSkyLight: input.sky !== false,
    out: input.out,
    assetDirs: (input.assetsDir ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
    blockInfo: input.blockInfo,
  };
}
