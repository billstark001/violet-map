import { createPublicObjectUrl } from '@violet-map/storage';
import path from 'node:path';
import type { StorageMount } from './configuration.js';
import type { configurationSettings } from './configurationSettings.js';

export function resourceConfiguration(settings: ReturnType<typeof configurationSettings>) {
  const { env, yamlValue, base, cwd } = settings;
  const obj = (value: unknown, allowed: string[], label: string): Record<string, unknown> => {
    if (value === undefined) return {};
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))
    )
      throw new Error(`invalid resources configuration: ${label}`);
    return value as Record<string, unknown>;
  };
  const root = obj(
    yamlValue('resources'),
    ['roles', 'cache', 'work', 'source', 'delivery', 'publication'],
    'resources',
  );
  const allowedEnv = new Set<string>();
  const read = (group: Record<string, unknown>, field: string, name: string, fallback: unknown) => {
    allowedEnv.add(name);
    return env[name] !== undefined ? env[name] : group[field] !== undefined ? group[field] : fallback;
  };
  const text = (value: unknown, name: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
    return value;
  };
  const integer = (value: unknown, min: number, name: string) => {
    const n = Number(value);
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      !String(value).trim() ||
      !Number.isSafeInteger(n) ||
      n < min
    )
      throw new Error(`${name} must be an integer >= ${min}`);
    return n;
  };
  const cache = obj(
    root.cache,
    ['memoryBytes', 'metadataBytes', 'local', 'sharedMount', 'sharedBytes', 'index', 'writeBytes'],
    'cache',
  );
  const work = obj(root.work, ['memoryBytes', 'handoffBytes', 'handoffMs', 'workspace'], 'work');
  const source = obj(root.source, ['consistency', 'revalidateMs', 'scope'], 'source');
  const delivery = obj(root.delivery, ['mode', 'targetMount', 'publicBaseUrl', 'httpPublisher'], 'delivery');
  const publication = obj(root.publication, ['storeMount', 'debounceMs', 'maxDelayMs', 'retainedMs'], 'publication');
  const mount = (group: Record<string, unknown>, field: string, stem: string): StorageMount | null => {
    const raw = group[field];
    const m = raw === null || raw === undefined ? {} : obj(raw, ['backend', 'prefix'], field);
    const backend = read(m, 'backend', stem + '_BACKEND', null);
    const prefix = read(m, 'prefix', stem + '_PREFIX', '');
    if (backend === null) {
      if (prefix) throw new Error(`${stem} prefix requires backend`);
      return null;
    }
    text(backend, stem);
    if (
      typeof prefix !== 'string' ||
      prefix.startsWith('/') ||
      prefix.includes('\\') ||
      prefix.split('/').some((p) => p === '.' || p === '..')
    )
      throw new Error(`invalid ${stem} prefix`);
    return { backend: backend as string, prefix: prefix.split('/').filter(Boolean).join('/') };
  };
  const directory = (group: Record<string, unknown>, field: string, stem: string, workspace: boolean) => {
    const raw = group[field];
    const m =
      raw === null || raw === undefined
        ? {}
        : obj(raw, ['directory', workspace ? 'maxBytes' : 'bytes', 'storageClass'], field);
    const dir = read(m, 'directory', stem + '_DIRECTORY', null);
    const amount = read(m, workspace ? 'maxBytes' : 'bytes', stem + (workspace ? '_MAX_BYTES' : '_BYTES'), 0);
    const storageClass = read(m, 'storageClass', stem + '_STORAGE_CLASS', null);
    if (dir === null) {
      if (Number(amount) !== 0 || storageClass !== null) throw new Error(`${stem} requires an explicit directory`);
      return null;
    }
    if (!['temporary', 'persistent'].includes(storageClass as string))
      throw new Error(`${stem} requires storageClass temporary or persistent`);
    return {
      directory: path.resolve(env[stem + '_DIRECTORY'] !== undefined ? cwd : base, text(dir, stem)),
      bytes: integer(amount, workspace ? 1 : 0, stem),
      storageClass: storageClass as 'temporary' | 'persistent',
    };
  };
  const rolesValue = read(root, 'roles', 'RESOURCES_ROLES', ['serve']);
  const roles = typeof rolesValue === 'string' ? rolesValue.split(',').map((s) => s.trim()) : rolesValue;
  if (
    !Array.isArray(roles) ||
    !roles.length ||
    roles.some((r) => !['serve', 'publish'].includes(r)) ||
    new Set(roles).size !== roles.length
  )
    throw new Error('resources.roles must contain serve and/or publish without duplicates');
  const mode = read(delivery, 'mode', 'RESOURCES_DELIVERY_MODE', 'server');
  if (mode !== 'server' && mode !== 'public') throw new Error('RESOURCES_DELIVERY_MODE must be server or public');
  const publicBaseUrl = read(delivery, 'publicBaseUrl', 'RESOURCES_PUBLIC_BASE_URL', null);
  if (publicBaseUrl !== null) createPublicObjectUrl(text(publicBaseUrl, 'RESOURCES_PUBLIC_BASE_URL'));
  const targetMount = mount(delivery, 'targetMount', 'RESOURCES_DELIVERY_TARGET_MOUNT');
  const httpConfig = obj(delivery.httpPublisher, ['url', 'tokenEnv'], 'HTTP publisher');
  const httpUrl = read(httpConfig, 'url', 'RESOURCES_HTTP_PUBLISHER_URL', null);
  const tokenEnv = read(httpConfig, 'tokenEnv', 'RESOURCES_HTTP_PUBLISHER_TOKEN_ENV', null);
  if (httpUrl !== null) createPublicObjectUrl(text(httpUrl, 'HTTP publisher URL'));
  if (httpUrl !== null && targetMount) throw new Error('choose targetMount or httpPublisher explicitly');
  if (httpUrl === null && tokenEnv !== null) throw new Error('HTTP publisher tokenEnv requires url');
  const httpToken =
    roles.includes('publish') && httpUrl !== null
      ? text(typeof tokenEnv === 'string' ? env[tokenEnv] : null, 'HTTP publisher token environment variable')
      : null;
  const httpPublisher = httpUrl === null ? null : { url: httpUrl as string, token: httpToken };
  const storeMount = mount(publication, 'storeMount', 'RESOURCES_PUBLICATION_STORE_MOUNT');
  if (
    (mode === 'public' || roles.includes('publish')) &&
    ((!targetMount && !httpPublisher) || !storeMount || !publicBaseUrl)
  )
    throw new Error('public/publish resources require targetMount, storeMount and publicBaseUrl');
  const index = obj(cache.index, ['driver', 'path'], 'index');
  const driver = read(index, 'driver', 'RESOURCES_CACHE_INDEX_DRIVER', 'memory');
  const indexPath = read(index, 'path', 'RESOURCES_CACHE_INDEX_PATH', null);
  if (driver !== 'memory' && driver !== 'sqlite')
    throw new Error('resources cache index driver must be memory or sqlite');
  if ((driver === 'sqlite') !== (indexPath !== null)) throw new Error('only sqlite index requires an explicit path');
  const consistency = read(source, 'consistency', 'RESOURCES_SOURCE_CONSISTENCY', 'snapshot');
  if (!['snapshot', 'bounded'].includes(consistency as string))
    throw new Error('resources source consistency must be snapshot or bounded');
  const result = {
    roles: roles as ('serve' | 'publish')[],
    cache: {
      memoryBytes: integer(
        read(cache, 'memoryBytes', 'RESOURCES_CACHE_MEMORY_BYTES', 64 * 1024 ** 2),
        0,
        'memoryBytes',
      ),
      metadataBytes: integer(
        read(cache, 'metadataBytes', 'RESOURCES_CACHE_METADATA_BYTES', 8 * 1024 ** 2),
        8192,
        'metadataBytes',
      ),
      local: directory(cache, 'local', 'RESOURCES_CACHE_LOCAL', false),
      sharedMount: mount(cache, 'sharedMount', 'RESOURCES_CACHE_SHARED_MOUNT'),
      sharedBytes: integer(read(cache, 'sharedBytes', 'RESOURCES_CACHE_SHARED_BYTES', 0), 0, 'sharedBytes'),
      index:
        driver === 'memory'
          ? { driver: 'memory' as const }
          : {
              driver: 'sqlite' as const,
              path: path.resolve(
                env.RESOURCES_CACHE_INDEX_PATH !== undefined ? cwd : base,
                text(indexPath, 'index path'),
              ),
            },
      writeBytes: integer(read(cache, 'writeBytes', 'RESOURCES_CACHE_WRITE_BYTES', 64 * 1024 ** 2), 0, 'writeBytes'),
    },
    work: {
      memoryBytes: integer(
        read(work, 'memoryBytes', 'RESOURCES_WORK_MEMORY_BYTES', 128 * 1024 ** 2),
        1,
        'work memoryBytes',
      ),
      handoffBytes: integer(
        read(work, 'handoffBytes', 'RESOURCES_WORK_HANDOFF_BYTES', 64 * 1024 ** 2),
        1,
        'handoffBytes',
      ),
      handoffMs: integer(read(work, 'handoffMs', 'RESOURCES_WORK_HANDOFF_MS', 30_000), 1, 'handoffMs'),
      workspace: directory(work, 'workspace', 'RESOURCES_WORK_WORKSPACE', true),
    },
    source: {
      consistency: consistency as 'snapshot' | 'bounded',
      revalidateMs: integer(read(source, 'revalidateMs', 'RESOURCES_SOURCE_REVALIDATE_MS', 5000), 1, 'revalidateMs'),
      scope: text(read(source, 'scope', 'RESOURCES_SOURCE_SCOPE', 'violet-map'), 'source scope'),
    },
    delivery: {
      mode: mode as 'server' | 'public',
      targetMount,
      httpPublisher,
      publicBaseUrl: publicBaseUrl as string | null,
    },
    publication: {
      storeMount,
      debounceMs: integer(read(publication, 'debounceMs', 'RESOURCES_PUBLICATION_DEBOUNCE_MS', 100), 0, 'debounceMs'),
      maxDelayMs: integer(read(publication, 'maxDelayMs', 'RESOURCES_PUBLICATION_MAX_DELAY_MS', 1000), 1, 'maxDelayMs'),
      retainedMs: integer(
        read(publication, 'retainedMs', 'RESOURCES_PUBLICATION_RETAINED_MS', 604800000),
        604800000,
        'retainedMs',
      ),
    },
  };
  if (result.source.revalidateMs > 5000) throw new Error('bounded source revalidation cannot exceed 5000 ms');
  if (result.cache.sharedBytes > 0 && !result.cache.sharedMount)
    throw new Error('sharedBytes > 0 requires sharedMount');
  for (const name of Object.keys(env))
    if (name.startsWith('RESOURCES_') && !allowedEnv.has(name))
      throw new Error(`unknown resource environment field: ${name}`);
  return result;
}

export type ResourceConfiguration = ReturnType<typeof resourceConfiguration>;
