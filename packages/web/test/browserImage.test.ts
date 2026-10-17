import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { loadBrowserImage } from '../src/browserImage.js';
import { buildAtlas } from '../src/atlas.js';
import { ViewerController, type ViewerOptions } from '../src/render/viewerEngine.js';

function imageFixture(t: { after(callback: () => void): void }) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const instances: ImageDouble[] = [];
  class ImageDouble {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    crossOrigin = '';
    src = '';
    constructor() {
      instances.push(this);
    }
    removeAttribute(name: string) {
      if (name === 'src') this.src = '';
    }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: ImageDouble });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'Image', previous);
    else delete (globalThis as { Image?: unknown }).Image;
  });
  return instances;
}

test('image completion, failure and abort release handlers; pre-aborted loads create no image', async (t) => {
  const images = imageFixture(t);
  const ready = loadBrowserImage('https://assets.test/ok');
  assert.equal(images[0].crossOrigin, 'anonymous');
  images[0].onload!();
  assert.equal(await ready, images[0]);
  assert.equal(images[0].onload, null);
  const failed = loadBrowserImage('https://assets.test/fail');
  images[1].onerror!();
  await assert.rejects(failed, /failed:/);
  assert.equal(images[1].onerror, null);
  const controller = new AbortController();
  const pending = loadBrowserImage('https://assets.test/slow', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(images[2].src, '');
  assert.equal(images[2].onload, null);
  await assert.rejects(loadBrowserImage('https://assets.test/not-started', controller.signal), { name: 'AbortError' });
  await assert.rejects(buildAtlas([], new Set(), controller.signal), { name: 'AbortError' });
  assert.equal(images.length, 3);
});

test('disposing a viewer during bootstrap aborts metadata and colormap IO without ready/error callbacks', async (t) => {
  const images = imageFixture(t);
  const signals: AbortSignal[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal);
        signals.push(signal);
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  let ready = 0,
    errors = 0;
  const viewer = new ViewerController(
    {} as HTMLElement,
    { world: 'bootstrap' } as ViewerOptions,
    () => {
      errors++;
    },
    () => {
      ready++;
    },
  );
  assert.equal(signals.length, 5, 'world capabilities plus four metadata documents');
  assert.equal(images.length, 2, 'grass and foliage colormaps');
  viewer.dispose();
  viewer.dispose();
  await setImmediate();
  assert.ok(signals.every((signal) => signal.aborted));
  assert.ok(images.every((image) => !image.src && !image.onload && !image.onerror));
  assert.equal(ready, 0);
  assert.equal(errors, 0);
});
