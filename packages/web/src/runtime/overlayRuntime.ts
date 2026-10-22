import { normalizeContentDimension, parseOverlayManifest } from '@violet-map/core/overlays';
import { resourceClient } from '../resources/client';
import { apiFetch } from '../runtime';
import { log } from '../logger';
import { OVERLAY_REFRESH_MS, OVERLAY_RETRY_MS } from '../scheduling/overlayPolicy';
import type { OverlayDisplay } from './overlayDisplay';
import type { OverlayDiagnosticSnapshot } from '../diagnostics/overlay';

const MANIFEST_TIMEOUT_MS = 30_000;

export interface OverlayTransport {
  head: typeof resourceClient.head;
  manifest: typeof apiFetch;
  assertCurrent: typeof resourceClient.assertCurrent;
}

export const overlayTransport: OverlayTransport = {
  head: resourceClient.head.bind(resourceClient),
  manifest: apiFetch,
  assertCurrent: resourceClient.assertCurrent.bind(resourceClient),
};

/** Owns overlay source identity and HTTP lifetime, without any graphics dependency. */
export class OverlayRuntime {
  private mapId: string | null = null;
  private dimension = '';
  private enabled = false;
  private loading = false;
  private disposed = false;
  private generation = 0;
  private abort: AbortController | null = null;
  private nextRefresh = 0;
  private etag: string | undefined;
  private sourceStatus: string | null = null;
  private manifestError: string | null = null;

  constructor(
    private readonly display: OverlayDisplay,
    private readonly transport: OverlayTransport,
  ) {}

  configure(mapId: string | null, dimension: string, enabled: boolean) {
    if (this.disposed) return;
    const dim = normalizeContentDimension(dimension);
    const active = !!mapId && enabled;
    if (this.mapId === mapId && this.dimension === dim && this.enabled === active) return;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.loading = false;
    this.display.reset();
    this.mapId = mapId;
    this.dimension = dim;
    this.enabled = active;
    this.display.setEnabled(active);
    this.manifestError = null;
    this.etag = undefined;
    this.sourceStatus = null;
    this.nextRefresh = 0;
    if (active) void this.refresh();
  }
  async refresh() {
    if (this.disposed || !this.enabled || !this.mapId || this.loading) return;
    const generation = this.generation,
      mapId = this.mapId,
      dimension = this.dimension,
      controller = new AbortController();
    this.abort = controller;
    this.loading = true;
    try {
      const view = await this.transport.head('', false, controller.signal);
      const response = await this.transport.manifest(
        'api/maps/' +
          encodeURIComponent(mapId) +
          '/overlays?dimension=' +
          encodeURIComponent(dimension) +
          '&viewId=' +
          encodeURIComponent(view.viewId),
        {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(MANIFEST_TIMEOUT_MS)]),
          headers: this.etag ? { 'if-none-match': this.etag } : undefined,
        },
      );
      if (controller.signal.aborted || generation !== this.generation || this.disposed) return;
      if (response.status === 304) {
        this.manifestError = null;
        return;
      }
      if (!response.ok) throw new Error(`overlay manifest: HTTP ${response.status}`);
      const manifest = parseOverlayManifest(await response.json());
      if (controller.signal.aborted || generation !== this.generation || this.disposed) return;
      this.transport.assertCurrent(view);
      if (manifest.mapId !== mapId || manifest.dimension !== dimension)
        throw new Error('overlay manifest belongs to a different map/dimension');
      this.display.apply(manifest);
      this.sourceStatus = manifest.sourceStatus;
      this.etag = response.headers.get('etag') ?? undefined;
      this.manifestError = null;
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation && !this.disposed) this.issueManifest(error);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.abort = null;
        this.nextRefresh = performance.now() + (this.manifestError ? OVERLAY_RETRY_MS : OVERLAY_REFRESH_MS);
      }
    }
  }

  tick(now: number) {
    if (this.disposed || !this.enabled || this.loading || now < this.nextRefresh) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void this.refresh();
  }

  private issueManifest(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.manifestError) log('warn', 'overlay', message, { feature: 'manifest' });
    this.manifestError = message;
  }

  diagnosticSnapshot(): OverlayDiagnosticSnapshot {
    const display = this.display.diagnosticSnapshot();
    const errors = this.manifestError
      ? [{ feature: 'manifest', message: this.manifestError }, ...display.errors]
      : display.errors;
    return {
      ...display,
      mapId: this.mapId,
      dimension: this.dimension,
      enabled: this.enabled,
      loading: this.loading,
      sourceStatus: this.sourceStatus,
      errors: errors.slice(0, 20),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.abort?.abort();
    this.display.dispose();
  }
}
