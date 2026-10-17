import { t } from '../i18n';
import { panelCollapsed, panelTab } from '../state/viewer';
import { handleTabKey } from '../tabs';
import { Panel } from './Panel';
import { SettingsTab } from './SettingsTab';
import { ViewTab } from './ViewTab';
import controls from './controls.module.css';
import styles from './ViewerPanel.module.css';

export function ViewerPanel() {
  const collapsed = panelCollapsed.value;
  const tab = panelTab.value;
  return (
    <Panel
      side="left"
      title="Violet Map"
      icon={`${import.meta.env.BASE_URL}brand/violet-map-logo-light.svg`}
      collapsed={collapsed}
      onToggle={() => {
        panelCollapsed.value = !collapsed;
      }}
      toggleLabel={t(collapsed ? 'expandPanel' : 'collapsePanel')}
    >
      <div role="tablist" className={controls.tabs} aria-label="Violet Map" onKeyDown={handleTabKey}>
        {(['view', 'settings'] as const).map((value) => (
          <button
            type="button"
            key={value}
            role="tab"
            id={`panel-tab-${value}`}
            aria-controls={`panel-content-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => {
              panelTab.value = value;
            }}
          >
            {t(value === 'view' ? 'tabView' : 'tabSettings')}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        className={styles.content}
        id="panel-content-view"
        aria-labelledby="panel-tab-view"
        hidden={tab !== 'view'}
      >
        <ViewTab />
      </div>
      <div
        role="tabpanel"
        className={styles.content}
        id="panel-content-settings"
        aria-labelledby="panel-tab-settings"
        hidden={tab !== 'settings'}
      >
        <SettingsTab />
      </div>
    </Panel>
  );
}
