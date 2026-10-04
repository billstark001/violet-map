import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { FlyControls, TopDownControls } from '../src/render/controls.js';

type Handler = (event: any) => void;

class FakeEvents {
  private readonly handlers = new Map<string, Set<Handler>>();

  addEventListener(type: string, handler: Handler) {
    const handlers = this.handlers.get(type) ?? new Set<Handler>();
    handlers.add(handler);
    this.handlers.set(type, handlers);
  }

  removeEventListener(type: string, handler: Handler) {
    this.handlers.get(type)?.delete(handler);
  }

  emit(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.handlers.get(type) ?? []) handler({ type, ...event });
  }
}

class FakeElement extends FakeEvents {
  isContentEditable = false;
  clientHeight = 100;
  private readonly captured = new Set<number>();

  constructor(readonly tagName: string) {
    super();
  }

  requestPointerLock() {}
  setPointerCapture(pointerId: number) {
    this.captured.add(pointerId);
  }
  hasPointerCapture(pointerId: number) {
    return this.captured.has(pointerId);
  }
  releasePointerCapture(pointerId: number) {
    this.captured.delete(pointerId);
  }
}

test('camera controls clear movement keys released over an input', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousElement = globalThis.HTMLElement;
  const documentEvents = new FakeEvents();
  const windowEvents = new FakeEvents();
  const canvas = new FakeElement('CANVAS');
  const input = new FakeElement('INPUT');
  Object.assign(globalThis, {
    document: Object.assign(documentEvents, { pointerLockElement: null }),
    window: windowEvents,
    HTMLElement: FakeElement,
  });
  try {
    const flyCamera = new THREE.PerspectiveCamera();
    const fly = new FlyControls(canvas as unknown as HTMLElement, flyCamera);
    documentEvents.emit('keydown', { code: 'KeyW', target: canvas });
    fly.update(1);
    const flyZ = flyCamera.position.z;
    assert.notEqual(flyZ, 0);
    documentEvents.emit('keyup', { code: 'KeyW', target: input });
    fly.update(1);
    assert.equal(flyCamera.position.z, flyZ);
    fly.dispose();

    const topCamera = new THREE.OrthographicCamera(-1, 1, 1, -1);
    const top = new TopDownControls(canvas as unknown as HTMLElement, topCamera);
    documentEvents.emit('keydown', { code: 'KeyW', target: canvas });
    top.update(1);
    const topZ = topCamera.position.z;
    assert.notEqual(topZ, 0);
    documentEvents.emit('keyup', { code: 'KeyW', target: input });
    top.update(1);
    assert.equal(topCamera.position.z, topZ);

    canvas.emit('pointerdown', { target: canvas, button: 0, pointerId: 3 });
    assert.equal(canvas.hasPointerCapture(3), true);
    windowEvents.emit('blur');
    assert.equal(canvas.hasPointerCapture(3), false);
    top.dispose();
  } finally {
    Object.assign(globalThis, {
      document: previousDocument,
      window: previousWindow,
      HTMLElement: previousElement,
    });
  }
});
