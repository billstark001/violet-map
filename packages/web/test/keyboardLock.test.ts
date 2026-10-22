import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NavigationKeyboardLock, type KeyboardLockState } from '../src/runtime/keyboardLock.js';
import { NAVIGATION_KEYS } from '../src/view/navigationKeys.js';

function fixture() {
  const events = new EventTarget();
  const states: KeyboardLockState[] = [];
  let enters = 0,
    exits = 0,
    unlocks = 0;
  const locked: string[][] = [];
  const doc = Object.assign(events, {
    fullscreenEnabled: true,
    fullscreenElement: null as object | null,
    documentElement: {
      async requestFullscreen() {
        enters++;
        doc.fullscreenElement = doc.documentElement;
        doc.dispatchEvent(new Event('fullscreenchange'));
      },
    },
    async exitFullscreen() {
      exits++;
      doc.fullscreenElement = null;
      doc.dispatchEvent(new Event('fullscreenchange'));
    },
  });
  const keyboard = {
    async lock(keys: string[]) {
      locked.push(keys);
    },
    unlock() {
      unlocks++;
    },
  };
  const control = new NavigationKeyboardLock((state) => states.push(state), doc as unknown as Document, keyboard);
  return { doc, keyboard, control, states, locked, counts: () => ({ enters, exits, unlocks }) };
}

test('keyboard capture is opt-in, locks only navigation, and releases owned fullscreen', async () => {
  const f = fixture();
  assert.equal(f.control.supported, true);
  assert.deepEqual(f.counts(), { enters: 0, exits: 0, unlocks: 0 });
  await f.control.enter();
  assert.deepEqual(f.locked, [NAVIGATION_KEYS]);
  assert.ok(!f.locked[0].includes('Escape'));
  assert.ok(!f.locked[0].includes('Tab'));
  assert.equal(f.states.at(-1)?.phase, 'active');
  await f.control.enter();
  assert.equal(f.counts().enters, 1);
  await f.control.exit();
  assert.equal(f.doc.fullscreenElement, null);
  assert.equal(f.counts().exits, 1);
  assert.equal(f.states.at(-1)?.phase, 'idle');
});

test('unsupported capture and denied permission never report a successful lock', async () => {
  const f = fixture();
  f.doc.fullscreenEnabled = false;
  assert.equal(f.control.supported, false);
  await f.control.enter();
  assert.equal(f.counts().enters, 0);
  f.doc.fullscreenEnabled = true;
  f.keyboard.lock = async () => {
    throw new DOMException('denied', 'NotAllowedError');
  };
  await f.control.enter();
  assert.equal(f.doc.fullscreenElement, null);
  assert.deepEqual(f.states.at(-1), { phase: 'idle', error: 'denied' });
});

test('Escape/fullscreen loss unlocks capture; existing fullscreen is not owned by the control', async () => {
  const f = fixture();
  f.doc.fullscreenElement = f.doc.documentElement;
  await f.control.enter();
  await f.control.exit();
  assert.equal(f.counts().enters, 0);
  assert.equal(f.counts().exits, 0);
  assert.equal(f.doc.fullscreenElement, f.doc.documentElement);
  await f.control.enter();
  f.doc.fullscreenElement = null;
  f.doc.dispatchEvent(new Event('fullscreenchange'));
  await Promise.resolve();
  assert.equal(f.states.at(-1)?.phase, 'idle');
  assert.ok(f.counts().unlocks > 0);
});

test('late keyboard permission cannot revive capture or unlock a replacement after fullscreen exit', async () => {
  const f = fixture();
  let complete!: () => void;
  f.keyboard.lock = () =>
    new Promise<void>((resolve) => {
      complete = resolve;
    });
  const entering = f.control.enter();
  await Promise.resolve();
  assert.equal(f.states.at(-1)?.phase, 'requesting');
  await f.doc.exitFullscreen();
  await f.control.enter();
  assert.equal(f.counts().enters, 1, 'retiring request must retain ownership');
  complete();
  await entering;
  assert.equal(f.states.at(-1)?.phase, 'idle');
  f.keyboard.lock = async (keys) => {
    f.locked.push(keys);
  };
  await f.control.enter();
  assert.equal(f.states.at(-1)?.phase, 'active');
  f.control.dispose();
  await Promise.resolve();
  assert.equal(f.doc.fullscreenElement, null);
  assert.equal(f.counts().exits, 2);
});

test('disposal during fullscreen admission releases a late fullscreen without requesting capture', async () => {
  const f = fixture();
  let complete!: () => void;
  f.doc.documentElement.requestFullscreen = () =>
    new Promise<void>((resolve) => {
      complete = resolve;
    });
  const entering = f.control.enter();
  f.control.dispose();
  f.doc.fullscreenElement = f.doc.documentElement;
  complete();
  await entering;
  assert.equal(f.doc.fullscreenElement, null);
  assert.equal(f.locked.length, 0);
  assert.equal(f.states.filter((state) => state.phase === 'active').length, 0);
});
