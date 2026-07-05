import { gzip } from 'pako';
import * as nbt from 'prismarine-nbt';
import minecraftData from 'minecraft-data';
import { config } from './config.js';

type Tag =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint | [number, number] }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'string'; value: string }
  | { type: 'list'; value: { type: string; value: Tag[] | string[] | number[] } }
  | { type: 'compound'; value: Record<string, Tag> };

function dataVersion(version: string): number {
  try {
    return (minecraftData(version) as any).version.dataVersion ?? 4189;
  } catch {
    return 4189;
  }
}

const byte = (value: boolean | number): Tag => ({ type: 'byte', value: typeof value === 'boolean' ? (value ? 1 : 0) : value });
const int = (value: number): Tag => ({ type: 'int', value });
const long = (value: bigint | number): Tag => ({ type: 'long', value: typeof value === 'bigint' ? value : BigInt(value) });
const double = (value: number): Tag => ({ type: 'double', value });
const string = (value: string): Tag => ({ type: 'string', value });
const compound = (value: Record<string, Tag>): Tag => ({ type: 'compound', value });
const stringList = (value: string[]): Tag => ({ type: 'list', value: { type: 'string', value } });

export interface LevelDatOptions {
  levelName: string;
  spawn?: { x: number; y: number; z: number };
  seed?: bigint | number;
}

export function createMinimalLevelDat(options: LevelDatOptions): Uint8Array {
  const dv = dataVersion(config.mcVersion);
  const now = Date.now();
  const spawn = options.spawn ?? { x: 0, y: 80, z: 0 };
  const seed = options.seed ?? 0;
  const root: Tag = compound({
    Data: compound({
      allowCommands: byte(false),
      BorderCenterX: double(0),
      BorderCenterZ: double(0),
      BorderDamagePerBlock: double(0.2),
      BorderSafeZone: double(5),
      BorderSize: double(60000000),
      BorderSizeLerpTarget: double(60000000),
      BorderSizeLerpTime: long(0),
      BorderWarningBlocks: double(5),
      BorderWarningTime: double(15),
      clearWeatherTime: int(0),
      DataPacks: compound({ Enabled: stringList(['vanilla']), Disabled: stringList([]) }),
      DataVersion: int(dv),
      DayTime: long(0),
      Difficulty: byte(2),
      DifficultyLocked: byte(false),
      GameRules: compound({
        doDaylightCycle: string('true'),
        doWeatherCycle: string('true'),
        doMobSpawning: string('true'),
        doFireTick: string('true'),
        keepInventory: string('false'),
      }),
      GameType: int(1),
      hardcore: byte(false),
      initialized: byte(true),
      LastPlayed: long(now),
      LevelName: string(options.levelName),
      MapFeatures: byte(true),
      raining: byte(false),
      rainTime: int(0),
      RandomSeed: long(seed),
      SpawnX: int(spawn.x),
      SpawnY: int(spawn.y),
      SpawnZ: int(spawn.z),
      thundering: byte(false),
      thunderTime: int(0),
      Time: long(0),
      version: int(19133),
      Version: compound({
        Id: int(dv),
        Name: string(config.mcVersion),
        Series: string('main'),
        Snapshot: byte(false),
      }),
      WasModded: byte(false),
      WorldGenSettings: compound({
        bonus_chest: byte(false),
        generate_features: byte(true),
        seed: long(seed),
        dimensions: compound({
          'minecraft:overworld': compound({
            type: string('minecraft:overworld'),
            generator: compound({ type: string('minecraft:noise'), settings: string('minecraft:overworld') }),
          }),
          'minecraft:the_nether': compound({
            type: string('minecraft:the_nether'),
            generator: compound({ type: string('minecraft:noise'), settings: string('minecraft:nether') }),
          }),
          'minecraft:the_end': compound({
            type: string('minecraft:the_end'),
            generator: compound({ type: string('minecraft:noise'), settings: string('minecraft:end') }),
          }),
        }),
      }),
    }),
  });
  return gzip(nbt.writeUncompressed({ type: 'compound', name: '', value: root.value } as any));
}
