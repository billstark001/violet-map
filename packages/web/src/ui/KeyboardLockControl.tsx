import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { NavigationKeyboardLock, type KeyboardLockState } from '../runtime/keyboardLock';
import { viewerReady } from '../state/viewer';
import controls from './controls.module.css';

export function KeyboardLockControl() {
  const ready = viewerReady.value;
  const [state, setState] = useState<KeyboardLockState>({ phase: 'idle', error: null });
  const [lock] = useState(() => new NavigationKeyboardLock(setState));
  useEffect(() => () => lock.dispose(), [lock]);
  useEffect(() => {
    if (!ready) void lock.exit();
  }, [lock, ready]);
  return (
    <div>
      <button
        type="button"
        className={controls.button}
        data-variant="soft"
        disabled={!ready || !lock.supported || state.phase === 'requesting'}
        aria-pressed={state.phase === 'active'}
        onClick={() => {
          void (state.phase === 'active' ? lock.exit() : lock.enter());
        }}
      >
        {t(state.phase === 'active' ? 'keyboardLockExit' : 'keyboardLockEnter')}
      </button>
      <p className={controls.text}>{t(lock.supported ? 'keyboardLockHint' : 'keyboardLockUnavailable')}</p>
      {state.error && (
        <p className={controls.text} role="status">
          {t('keyboardLockFailed', { message: state.error })}
        </p>
      )}
    </div>
  );
}
