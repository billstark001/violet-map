import { parseServiceCapabilities } from '@violet-map/core/contracts';
import type { CliContext } from '../context.js';
import { loadCapability } from '../capabilities.js';
import { apiRequest, jsonRequest, resolveServerConnection } from '../remote.js';

export interface ResourceOptions {
  via?: 'api' | 'local';
  serverConfig?: string;
  expectedHead?: string;
  writersQuiesced?: boolean;
  output?: string;
  prepared?: string;
}

export async function resourceCommand(
  operation: 'prepare' | 'publish' | 'status' | 'verify' | 'gc' | 'reindex' | 'recover',
  options: ResourceOptions,
  context?: CliContext,
) {
  if (options.output && operation !== 'prepare') throw new TypeError('--output is only valid for prepare');
  if (options.prepared && operation !== 'publish') throw new TypeError('--prepared is only valid for publish');
  let prepared: import('@violet-map/core/resources').PublicationManifest | undefined;
  if (options.prepared) {
    const { stat, readFile } = await import('node:fs/promises');
    if ((await stat(options.prepared)).size > 8 * 1024 ** 2)
      throw new RangeError('prepared publication exceeds input budget');
    // The selected writer validates the current protocol. API-only CLI installs
    // must not load the optional Node resource/generator package to send it.
    prepared = JSON.parse(await readFile(options.prepared, 'utf8'));
  }
  const preparedResult = async (manifest: unknown) => {
    if (!options.output) return manifest;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(options.output, JSON.stringify(manifest, null, 2) + '\n');
    return { prepared: options.output };
  };
  if (operation === 'publish' && options.expectedHead !== 'none' && !/^[a-f0-9]{64}$/.test(options.expectedHead ?? ''))
    throw new TypeError('expected-head must be a SHA-256 or none');
  if ((options.via ?? 'api') === 'api') {
    if (options.serverConfig || options.writersQuiesced)
      throw new TypeError('local configuration and quiescence flags require --via local');
    if (operation === 'recover') throw new TypeError('recovery requires a quiesced local publisher');
    if (!context) throw new TypeError('API resources require a CLI connection');
    const connection = await resolveServerConnection(context);
    const capabilities = parseServiceCapabilities(await apiRequest(connection, 'api/capabilities'));
    if (!capabilities.adminApi) throw new Error('resource management API is disabled');
    const endpoint = operation === 'publish' ? 'publications' : operation;
    const result = await apiRequest(
      connection,
      `api/admin/resources/${endpoint}`,
      operation === 'status'
        ? undefined
        : jsonRequest(
            'POST',
            operation === 'publish'
              ? {
                  expectedHead: options.expectedHead === 'none' ? null : options.expectedHead,
                  ...(prepared !== undefined ? { prepared } : {}),
                }
              : {},
          ),
    );
    return operation === 'prepare' ? preparedResult(result) : result;
  }
  if (!options.serverConfig) throw new TypeError('--via local requires --server-config');
  if (['prepare', 'publish', 'gc', 'reindex', 'recover'].includes(operation) && !options.writersQuiesced)
    throw new TypeError('stop every other writer and pass --writers-quiesced for local resource changes');
  const { loadServerConfig } = await loadCapability('@violet-map/server/configuration');
  const config = loadServerConfig({ configFile: options.serverConfig });
  if (operation === 'reindex' && config.resources.cache.index.driver === 'sqlite') {
    const { rm } = await import('node:fs/promises');
    const file = config.resources.cache.index.path;
    // Only the explicitly disposable selected index is rebuilt. Authority and
    // media originals are never removed by this operation.
    for (const suffix of ['', '-wal', '-shm']) await rm(file + suffix, { force: true });
  }
  const { createServices } = await loadCapability('@violet-map/server/services');
  const services = await createServices(config, { resumePublications: false });
  try {
    switch (operation) {
      case 'prepare': {
        const manifest = await services.resources.prepare();
        return await preparedResult(manifest);
      }
      case 'publish':
        return await services.resources.publish(
          options.expectedHead === 'none' ? null : options.expectedHead,
          prepared,
        );
      case 'status':
        return await services.resources.status();
      case 'verify':
        return await services.resources.verify();
      case 'gc':
        return await services.resources.gc();
      case 'recover':
        return await services.resources.recover(true);
      case 'reindex':
        return {
          originals: services.content ? await services.content.verifyRetainedMedia() : 0,
          actions: await services.resources.reindex(),
        };
    }
  } finally {
    await services.close();
  }
}
