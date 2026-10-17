import { batch, useSignal, useSignalEffect } from '@preact/signals';
import { t } from '../i18n';
import { cameraDraft, parseCameraDraft, type CameraDraft } from '../state/camera';
import { cameraTarget, stats } from '../state/viewer';
import controls from './controls.module.css';
import styles from './CameraFields.module.css';

export function CameraFields() {
  const draft = useSignal<CameraDraft>(cameraDraft(stats.peek()));
  const dirty = useSignal(false);
  useSignalEffect(() => {
    const next = cameraDraft(stats.value);
    if (dirty.value) return;
    const previous = draft.peek();
    if (Object.keys(next).some((key) => next[key as keyof CameraDraft] !== previous[key as keyof CameraDraft]))
      draft.value = next;
  });
  const setAxis = (axis: keyof CameraDraft, value: string) =>
    batch(() => {
      dirty.value = true;
      draft.value = { ...draft.peek(), [axis]: value };
    });
  const reset = () =>
    batch(() => {
      draft.value = cameraDraft(stats.peek());
      dirty.value = false;
    });
  const apply = () => {
    const next = parseCameraDraft(draft.peek());
    if (!next) return;
    batch(() => {
      cameraTarget.value = { ...next, seq: (cameraTarget.peek()?.seq ?? 0) + 1 };
      dirty.value = false;
    });
  };
  const field = (axis: keyof CameraDraft) => (
    <label className={styles.field} htmlFor={`${axis === 'yaw' || axis === 'pitch' ? 'angle' : 'coord'}-${axis}`}>
      <span>{axis === 'yaw' ? 'Yaw' : axis === 'pitch' ? 'Pitch' : axis.toUpperCase()}</span>
      <input
        className={controls.input}
        id={`${axis === 'yaw' || axis === 'pitch' ? 'angle' : 'coord'}-${axis}`}
        type="number"
        step={axis === 'yaw' || axis === 'pitch' ? 1 : 'any'}
        value={draft.value[axis]}
        onInput={(event) => setAxis(axis, event.currentTarget.value)}
      />
    </label>
  );
  return (
    <div className={styles.fields}>
      <div className={styles.row}>{(['x', 'y', 'z'] as const).map(field)}</div>
      <div className={styles.row}>
        {(['yaw', 'pitch'] as const).map(field)}
        <button className={controls.button} data-variant="soft" onClick={reset} type="button">
          {t('current')}
        </button>
        <button className={controls.button} disabled={!parseCameraDraft(draft.value)} onClick={apply} type="button">
          {t('go')}
        </button>
      </div>
    </div>
  );
}
