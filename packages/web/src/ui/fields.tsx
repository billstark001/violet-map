import type { ComponentChildren } from 'preact';
import controls from './controls.module.css';
import styles from './fields.module.css';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/** A labelled native select; preserves platform keyboard and assistive-technology behavior. */
export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange(value: T): void;
}) {
  return (
    <label className={styles.row} htmlFor={id}>
      <span className={styles.caption}>{label}</span>
      <select
        id={id}
        className={controls.select}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RangeField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange(value: number): void;
}) {
  return (
    <label className={styles.range} htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        className={controls.range}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onInput={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

export function ToggleField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className={styles.row} htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        className={controls.switch}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

export function FieldGroup({ children }: { children: ComponentChildren }) {
  return <div className={styles.group}>{children}</div>;
}
