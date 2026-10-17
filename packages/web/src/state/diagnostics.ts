import { batch, signal } from '@preact/signals';
import { uploadDiagnosticSnapshot } from '../api';
import { apiTokenKey, serviceCapabilities } from '../runtime';
import { browserStorage, readStored } from './settings';
import { diagnosticProvider } from './viewer';

export const diagnosticToken = signal('');
export const uploadStatus = signal<'idle' | 'uploading' | 'uploaded' | 'error'>('idle');
export const uploadMessage = signal('');

const tokenKey = () => apiTokenKey('diagnostic-server-token');

export function initializeDiagnostics(): void {
  diagnosticToken.value = readStored(browserStorage('sessionStorage'), tokenKey()) ?? '';
}

export function setDiagnosticToken(value: string): void {
  diagnosticToken.value = value;
  try {
    const storage = browserStorage('sessionStorage');
    if (value) storage?.setItem(tokenKey(), value);
    else storage?.removeItem(tokenKey());
  } catch {
    /* restricted storage */
  }
}

export function downloadDiagnosticSnapshot(): void {
  const snapshot = diagnosticProvider.peek()?.();
  if (!snapshot) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `violet-map-diagnosis-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function uploadDiagnostics(): Promise<void> {
  const snapshot = diagnosticProvider.peek()?.();
  const token = diagnosticToken.peek().trim();
  if (!serviceCapabilities().diagnostics || !snapshot || !token || uploadStatus.peek() === 'uploading') return;
  batch(() => {
    uploadStatus.value = 'uploading';
    uploadMessage.value = '';
  });
  try {
    const { id } = await uploadDiagnosticSnapshot(snapshot, token);
    batch(() => {
      uploadStatus.value = 'uploaded';
      uploadMessage.value = id;
    });
  } catch (error) {
    batch(() => {
      uploadStatus.value = 'error';
      uploadMessage.value = error instanceof Error ? error.message : String(error);
    });
  }
}
