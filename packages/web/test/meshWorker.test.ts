import assert from 'node:assert/strict';
import { test } from 'node:test';

function chunkNbt(blockEntityY?: number): ArrayBuffer {
  const bytes: number[] = [];
  const byte = (value: number) => {
    bytes.push(value & 0xff);
  };
  const short = (value: number) => {
    byte(value >> 8);
    byte(value);
  };
  const int = (value: number) => {
    byte(value >> 24);
    byte(value >> 16);
    byte(value >> 8);
    byte(value);
  };
  const string = (value: string) => {
    const encoded = new TextEncoder().encode(value);
    short(encoded.length);
    bytes.push(...encoded);
  };
  const tag = (type: number, name: string) => {
    byte(type);
    string(name);
  };

  tag(10, '');
  tag(3, 'xPos');
  int(0);
  tag(3, 'zPos');
  int(0);
  tag(9, 'sections');
  byte(10);
  int(1);
  tag(1, 'Y');
  byte(0);
  tag(10, 'block_states');
  tag(9, 'palette');
  byte(10);
  int(1);
  tag(8, 'Name');
  string('minecraft:stone');
  byte(0); // palette compound
  byte(0); // block_states compound
  byte(0); // section compound
  if (blockEntityY !== undefined) {
    tag(9, 'block_entities');
    byte(10);
    int(1);
    tag(8, 'id');
    string('test:marker');
    tag(3, 'x');
    int(0);
    tag(3, 'y');
    int(blockEntityY);
    tag(3, 'z');
    int(0);
    byte(0); // block entity compound
  }
  byte(0); // root compound
  return new Uint8Array(bytes).buffer;
}

test('worker reports meshing failures and renders objects outside stored sections', async () => {
  const messages: Array<{ type: string; version?: number; kind?: string }> = [];
  const previousSelf = globalThis.self;
  const worker = Object.assign(Object.create(globalThis), {
    postMessage: (message: { type: string }) => {
      messages.push(message);
    },
    onmessage: null as null | ((event: { data: unknown }) => void),
  });
  Object.assign(globalThis, { self: worker });
  try {
    await import('../src/worker/meshWorker.js');
    const send = (data: unknown) => worker.onmessage!({ data });
    send({
      type: 'init',
      bundle: {
        blockstates: { 'minecraft:stone': { variants: { '': { model: 'minecraft:block/bad' } } } },
        models: {
          'minecraft:block/bad': {
            elements: [{ from: null, to: [16, 16, 16], faces: { up: { texture: 'minecraft:block/stone' } } }],
          },
        },
      },
      blockInfo: { 'minecraft:stone': { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' } },
      biomes: {},
      atlasIndex: {},
      avgColors: {},
      textureHasAlpha: {},
      textureAnimationIds: {},
      grassColormap: null,
      foliageColormap: null,
    });
    const key = 'test|minecraft:overworld|0,0';
    send({ type: 'chunk', key, cx: 0, cz: 0, dimension: { hasSkyLight: false }, chunk: chunkNbt() });
    assert.ok(messages.some((message) => message.type === 'chunkReady'));
    send({ type: 'mesh', key, version: 7 });
    send({ type: 'lod', key, step: 2, version: 8 });
    assert.ok(
      messages.some((message) => message.type === 'meshError' && message.version === 7 && message.kind === 'full'),
    );
    assert.ok(
      messages.some((message) => message.type === 'meshError' && message.version === 8 && message.kind === 'lod'),
    );

    send({
      type: 'init',
      bundle: {
        blockstates: {},
        models: {
          'test:marker': {
            elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: 'test:block/marker' } } }],
          },
        },
        renderers: { blockEntities: { 'test:marker': { model: 'test:marker' } } },
      },
      blockInfo: {},
      biomes: {},
      atlasIndex: {
        __missing__: { u0: 0, v0: 0, u1: 1, v1: 1 },
        'test:block/marker': { u0: 0, v0: 0, u1: 1, v1: 1 },
      },
      avgColors: {},
      textureHasAlpha: {},
      textureAnimationIds: {},
      grassColormap: null,
      foliageColormap: null,
    });
    send({ type: 'chunk', key, cx: 0, cz: 0, dimension: { hasSkyLight: false }, chunk: chunkNbt(32) });
    send({ type: 'mesh', key, version: 9 });
    const mesh = messages.find((message) => message.type === 'meshResult' && message.version === 9) as
      | { sections: { sy: number; layers: Record<string, unknown> }[] }
      | undefined;
    assert.ok(mesh, 'expected a full mesh result');
    assert.ok(mesh.sections.some((section) => section.sy === 2 && section.layers.specialOpaque));
  } finally {
    Object.assign(globalThis, { self: previousSelf });
  }
});
