import type { ComponentChildren } from 'preact';
import controls from './controls.module.css';
import styles from './Panel.module.css';

export function Panel({
  side,
  title,
  icon,
  collapsed,
  onToggle,
  toggleLabel,
  children,
}: {
  side: 'left' | 'right';
  title: string;
  icon?: string;
  collapsed: boolean;
  onToggle(): void;
  toggleLabel: string;
  children: ComponentChildren;
}) {
  return (
    <section className={`${styles.panel} ${styles[side]} ${collapsed ? styles.collapsed : ''}`} aria-label={title}>
      <div className={styles.heading}>
        {!collapsed && (
          <strong className={styles.title}>
            {icon && <img src={icon} alt="" width="28" height="21" />}
            {title}
          </strong>
        )}
        <button
          className={`${controls.button} ${styles.collapse}`}
          data-variant="ghost"
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          onClick={onToggle}
          type="button"
        >
          {side === 'left' ? (collapsed ? '>' : '<') : collapsed ? 'i' : '×'}
        </button>
      </div>
      <div hidden={collapsed} className={styles.body}>
        {children}
      </div>
    </section>
  );
}
