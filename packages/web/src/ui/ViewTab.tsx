import { t } from '../i18n';
import {
  activeOverlayMap,
  dimensions,
  loadWorlds,
  overlayMaps,
  overlayStatus,
  settings,
  worlds,
  worldsError,
  worldsLoading,
} from '../state/viewer';
import {
  defaultTopClipRange,
  normalizeTopClipRange,
  TOP_CLIP_MAX_Y,
  TOP_CLIP_MIN_Y,
  TOP_CLIP_STEP,
} from '../state/settings';
import type { ViewMode } from '../render/viewerEngine';
import { CameraFields } from './CameraFields';
import { FieldGroup, RangeField, SelectField, ToggleField } from './fields';
import controls from './controls.module.css';

function OverlayStatus() {
  const status = overlayStatus.value;
  if (!settings.state.value.overlaysEnabled || !status) return null;
  const limited = status.suppressed > 0 || status.maskLimited || status.samplingLimited > 0;
  return (
    <p className={controls.text} role="status" data-testid="overlay-status">
      {status.loading ? t('overlaysLoading') : t('overlaysLoaded', { count: status.features })}
      {status.sourceStatus &&
        !['verified', 'unverified'].includes(status.sourceStatus) &&
        ` · ${t('overlaySourceUnavailable')}`}
      {status.errors.length > 0 && ` · ${t('overlayError')}: ${status.errors[0].message}`}
      {limited && ` · ${t('overlayBudget')}`}
    </p>
  );
}

function OverlayControls() {
  const mapId = activeOverlayMap.value;
  if (!mapId) return null;
  return (
    <FieldGroup>
      <ToggleField
        id="overlay-toggle"
        label={t('overlays')}
        checked={settings.state.value.overlaysEnabled}
        onChange={(overlaysEnabled) => settings.update({ overlaysEnabled })}
      />
      {overlayMaps.value.length > 1 && (
        <SelectField
          id="overlay-map"
          label={t('overlayMap')}
          value={mapId}
          options={overlayMaps.value.map((value) => ({ value, label: value }))}
          onChange={(overlayMapId) => settings.update({ overlayMapId })}
        />
      )}
      <OverlayStatus />
    </FieldGroup>
  );
}

export function ViewTab() {
  const value = settings.state.value;
  const { topClipRange } = value;
  const clip = (patch: Partial<typeof topClipRange>) =>
    settings.update({ topClipRange: normalizeTopClipRange({ ...topClipRange, ...patch }) });
  return (
    <FieldGroup>
      <SelectField
        id="world-select"
        label={t('world')}
        value={value.world}
        options={worlds.value.map((world) => ({ value: world.id, label: world.id }))}
        onChange={(world) => {
          const next = worlds.peek().find((item) => item.id === world);
          settings.update({
            world,
            dimension: next?.dimensions.includes(value.dimension)
              ? value.dimension
              : (next?.dimensions[0] ?? value.dimension),
          });
        }}
      />
      {worldsError.value && (
        <div role="alert" className={controls.text}>
          {worldsError.value}{' '}
          <button
            className={controls.button}
            type="button"
            disabled={worldsLoading.value}
            onClick={() => {
              void loadWorlds();
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}
      <SelectField
        id="dimension-select"
        label={t('dimension')}
        value={value.dimension}
        options={dimensions.value.map((dimension) => ({
          value: dimension,
          label: dimension.replace('minecraft:', ''),
        }))}
        onChange={(dimension) => settings.update({ dimension })}
      />
      <OverlayControls />
      <RangeField
        id="view-distance"
        label={t('fullRadius', { value: value.viewDistance })}
        value={value.viewDistance}
        min={2}
        max={32}
        onChange={(viewDistance) => settings.update({ viewDistance })}
      />
      <RangeField
        id="lod-distance"
        label={t('lodRadius', { value: value.lodDistance })}
        value={value.lodDistance}
        min={0}
        max={128}
        onChange={(lodDistance) => settings.update({ lodDistance })}
      />
      <RangeField
        id="fast-move"
        label={t('fastMove', { value: value.fastMoveMultiplier.toFixed(1) })}
        value={value.fastMoveMultiplier}
        min={1}
        max={16}
        step={0.5}
        onChange={(fastMoveMultiplier) => settings.update({ fastMoveMultiplier })}
      />
      <ToggleField
        id="inertia-toggle"
        label={t('inertia')}
        checked={value.inertiaEnabled}
        onChange={(inertiaEnabled) => settings.update({ inertiaEnabled })}
      />
      <SelectField<ViewMode>
        id="view-mode"
        label={t('viewMode')}
        value={value.viewMode}
        options={(['perspective', 'topPerspective', 'topOrthographic'] as const).map((mode) => ({
          value: mode,
          label: t(
            {
              perspective: 'viewModePerspective',
              topPerspective: 'viewModeTopPerspective',
              topOrthographic: 'viewModeTopOrthographic',
            }[mode],
          ),
        }))}
        onChange={(viewMode) => settings.update({ viewMode })}
      />
      <RangeField
        id="top-clip-min"
        label={t('topClipMinY', { value: topClipRange.minY })}
        value={topClipRange.minY}
        min={TOP_CLIP_MIN_Y}
        max={TOP_CLIP_MAX_Y}
        step={TOP_CLIP_STEP}
        onChange={(minY) => clip({ minY: Math.min(minY, topClipRange.maxY) })}
      />
      <RangeField
        id="top-clip-max"
        label={t('topClipMaxY', { value: topClipRange.maxY })}
        value={topClipRange.maxY}
        min={TOP_CLIP_MIN_Y}
        max={TOP_CLIP_MAX_Y}
        step={TOP_CLIP_STEP}
        onChange={(maxY) => clip({ maxY: Math.max(maxY, topClipRange.minY) })}
      />
      <div>
        <button
          type="button"
          className={controls.button}
          data-variant="soft"
          onClick={() => settings.update({ topClipRange: defaultTopClipRange(value.dimension) })}
        >
          {t('topClipReset')}
        </button>
      </div>
      <RangeField
        id="time-of-day"
        label={t('timeOfDay', { value: value.timeOfDay.toFixed(2) })}
        value={value.timeOfDay}
        min={0}
        max={1}
        step={0.01}
        onChange={(timeOfDay) => settings.update({ timeOfDay })}
      />
      <CameraFields />
    </FieldGroup>
  );
}
