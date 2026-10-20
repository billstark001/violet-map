import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { runBakeTopMap } from '../../../packages/cli/src/commands/bake.js';

const requireCore = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const nbt = requireCore('prismarine-nbt');
const { PNG } = createRequire(new URL('../../../packages/resources/package.json', import.meta.url))('pngjs');

/** Entirely synthetic: no private world, installed Minecraft archive or provider credentials. */
export async function resourceFixture(root: string) {
  const assets = path.join(root, 'assets');
  const worlds = path.join(root, 'worlds');
  const world = path.join(worlds, 'fixture');
  const write = async (file: string, bytes: Uint8Array | string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  };
  const json = (file: string, value: unknown) => write(file, JSON.stringify(value));
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([80, 160, 40, 255], i);
  const pngBytes = new Uint8Array(PNG.sync.write(png));
  await write(path.join(assets, 'test/textures/block/surface.png'), pngBytes);
  await json(path.join(assets, 'test/models/block/surface.json'), { textures: { all: 'test:block/surface' } });
  await json(path.join(assets, 'test/blockstates/surface.json'), { variants: { '': { model: 'test:block/surface' } } });
  await json(path.join(world, '.violet-map/identity.json'), { schema: 1, id: 'a5d7ce72-0021-40ea-8cf3-ec1ff0fc0777' });
  const chunk = (cx: number, cz: number, block: string) =>
    new Uint8Array(
      nbt.writeUncompressed({
        type: 'compound',
        name: '',
        value: {
          xPos: { type: 'int', value: cx },
          zPos: { type: 'int', value: cz },
          sections: {
            type: 'list',
            value: {
              type: 'compound',
              value: [
                {
                  Y: { type: 'byte', value: 0 },
                  block_states: {
                    type: 'compound',
                    value: {
                      palette: {
                        type: 'list',
                        value: { type: 'compound', value: [{ Name: { type: 'string', value: block } }] },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      }),
    );
  const region = (data: Uint8Array, cx: number, cz: number) => {
    const compressed = deflateSync(data);
    const sectors = Math.ceil((compressed.length + 5) / 4096);
    const buffer = Buffer.alloc((2 + sectors) * 4096);
    buffer.writeUInt32BE((2 << 8) | sectors, ((cx & 31) + (cz & 31) * 32) * 4);
    buffer.writeUInt32BE(compressed.length + 1, 8192);
    buffer[8196] = 2;
    buffer.set(compressed, 8197);
    return buffer;
  };
  // One MCA chunk plus an overriding NBT and a negative-coordinate region.
  await write(path.join(world, 'region/r.0.0.mca'), region(chunk(0, 0, 'minecraft:dirt'), 0, 0));
  await write(path.join(world, 'chunks/minecraft%3Aoverworld/c.0.0.nbt'), chunk(0, 0, 'minecraft:stone'));
  await write(path.join(world, 'region/r.-1.0.mca'), region(chunk(-1, 0, 'minecraft:stone'), -1, 0));
  await write(path.join(world, 'DIM-1/region/r.0.0.mca'), region(chunk(0, 0, 'minecraft:netherrack'), 0, 0));
  await runBakeTopMap({ world, assetsDir: assets, sampleStride: 16, colorStride: 16, lightStride: 16, sky: true });
  await runBakeTopMap({
    world,
    assetsDir: assets,
    dim: 'minecraft:the_nether',
    sampleStride: 16,
    colorStride: 16,
    lightStride: 16,
    sky: false,
  });
  return { assets, worlds, world, pngBytes, chunk };
}
