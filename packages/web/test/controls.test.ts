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
    const dispatched = {
      type,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...event,
    };
    for (const handler of this.handlers.get(type) ?? []) handler(dispatched);
    return dispatched;
  }
}

class FakeElement extends FakeEvents {
  isContentEditable = false;
  parentElement: FakeElement | null = null;
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

test('camera shortcuts prevent browser selection and scrolling without intercepting text editing', () => {
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  const documentEvents = new FakeEvents();
  const canvas = new FakeElement('CANVAS');
  Object.assign(globalThis, {
    document: Object.assign(documentEvents, { pointerLockElement: null }),
    window: new FakeEvents(),
    HTMLElement: FakeElement,
  });
  try {
    for (const create of [
      () => new FlyControls(canvas as unknown as HTMLElement, new THREE.PerspectiveCamera()),
      () => new TopDownControls(canvas as unknown as HTMLElement, new THREE.OrthographicCamera()),
    ]) {
      const controls = create();
      try {
        for (const modifiers of [{ ctrlKey: true }, { shiftKey: true }, {}]) {
          assert.equal(
            documentEvents.emit('keydown', { code: 'KeyA', target: canvas, ...modifiers }).defaultPrevented,
            true,
          );
        }
        for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY', 'DIV']) {
          const target = new FakeElement(tag);
          if (tag === 'DIV') target.isContentEditable = true;
          assert.equal(documentEvents.emit('keydown', { code: 'KeyA', target, ctrlKey: true }).defaultPrevented, false);
        }
        assert.equal(
          documentEvents.emit('keydown', { code: 'KeyC', target: canvas, ctrlKey: true }).defaultPrevented,
          false,
        );
        controls.setEnabled(false);
        assert.equal(
          documentEvents.emit('keydown', { code: 'KeyA', target: canvas, ctrlKey: true }).defaultPrevented,
          false,
        );
      } finally {
        controls.dispose();
      }
    }
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('control disposal stops held movement, releases locks and tolerates denied pointer lock', async () => {
  const previous = { document: globalThis.document, window: globalThis.window, HTMLElement: globalThis.HTMLElement };
  const events = new FakeEvents();
  const canvas = new FakeElement('CANVAS');
  let unlocked = 0;
  const document = Object.assign(events, {
    pointerLockElement: canvas as FakeElement | null,
    exitPointerLock() {
      unlocked++;
      this.pointerLockElement = null;
    },
  });
  Object.assign(globalThis, { document, window: new FakeEvents(), HTMLElement: FakeElement });
  try {
    const camera = new THREE.PerspectiveCamera();
    const fly = new FlyControls(canvas as unknown as HTMLElement, camera);
    canvas.requestPointerLock = () => Promise.reject(new Error('permission denied'));
    canvas.emit('click');
    await new Promise((resolve) => setImmediate(resolve));
    events.emit('keydown', { code: 'KeyW', target: canvas });
    fly.update(1);
    const before = camera.position.clone();
    fly.dispose();
    fly.update(1);
    assert.deepEqual(camera.position, before);
    assert.equal(unlocked, 1);
    const topCamera = new THREE.OrthographicCamera();
    const top = new TopDownControls(canvas as unknown as HTMLElement, topCamera);
    canvas.emit('pointerdown', { target: canvas, button: 0, pointerId: 7 });
    canvas.releasePointerCapture(7);
    canvas.emit('lostpointercapture', { pointerId: 7 });
    const origin = topCamera.position.clone();
    canvas.emit('pointermove', { pointerId: 7, movementX: 10, movementY: 10 });
    assert.deepEqual(topCamera.position, origin);
    events.emit('keydown', { code: 'KeyW', target: canvas });
    top.dispose();
    top.update(1);
    assert.deepEqual(topCamera.position, origin);
  } finally {
    Object.assign(globalThis, previous);
  }
});
