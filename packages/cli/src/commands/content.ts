import { parseServiceCapabilities } from '@violet-map/core/contracts';
import {
  contentId,
  normalizeContentDimension,
  parseLayerDocument,
  revisionTag,
  type MapDocument,
} from '@violet-map/core/overlays';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CliContext } from '../context.js';
import { apiRequest, jsonRequest, remoteOrigin, resolveServerConnection, type ServerConnection } from '../remote.js';

export interface ContentOptions {
  name?: string;
  world?: string;
  expectedArchiveId?: string;
  unbound?: boolean;
  ifMatch?: number;
  map?: string;
  layer?: string;
  binding?: string;
  dimension?: string;
  order?: number;
  disabled?: boolean;
  revision?: number;
  output?: string;
  asset?: string;
  type?: string;
  version?: string;
}

export async function validateLayer(file: string) {
  return parseLayerDocument(JSON.parse(await fs.readFile(file, 'utf8')));
}

async function connection(
  context: CliContext,
  access: 'public' | 'admin' | 'write' = 'admin',
): Promise<ServerConnection> {
  const server =
    access === 'public' ? { url: remoteOrigin(context), token: '' } : await resolveServerConnection(context);
  const capabilities = parseServiceCapabilities(await apiRequest(server, 'api/capabilities'));
  if (
    !capabilities.contentReads ||
    (access !== 'public' && !capabilities.adminApi) ||
    (access === 'write' && !capabilities.contentWrites)
  )
    throw new Error('Server content capability is unavailable for this operation');
  return server;
}

function conditional(options: ContentOptions, method: string, body?: unknown): RequestInit {
  if (!Number.isSafeInteger(options.ifMatch) || options.ifMatch! < 1)
    throw new Error('An explicit --if-match revision is required');
  const init = jsonRequest(method, body);
  return { ...init, headers: { ...init.headers, 'if-match': revisionTag(options.ifMatch!) } };
}

const segment = (id: string) => encodeURIComponent(contentId(id));

export async function mapCommand(context: CliContext, operation: string, args: string[], options: ContentOptions) {
  const server = await connection(context, ['register', 'rebind', 'delete'].includes(operation) ? 'write' : 'admin');
  const base = 'api/admin/maps';
  const id = args[0];
  if (operation === 'list') return apiRequest(server, base);
  if (operation === 'register')
    return apiRequest(
      server,
      base,
      jsonRequest('POST', {
        schemaVersion: 1,
        name: options.name ?? options.world,
        worldKey: options.unbound ? null : options.world,
        expectedArchiveId: options.expectedArchiveId,
        bindings: [],
      }),
    );
  if (operation === 'show') return apiRequest(server, `${base}/${segment(id)}`);
  if (operation === 'delete') return apiRequest(server, `${base}/${segment(id)}`, conditional(options, 'DELETE'));
  const current = await apiRequest<MapDocument>(server, `${base}/${segment(id)}`);
  const body = {
    ...current,
    revision: (options.ifMatch ?? 0) + 1,
    worldKey: options.unbound ? null : options.world,
    ...(options.name ? { name: options.name } : {}),
    ...(options.expectedArchiveId ? { expectedArchiveId: options.expectedArchiveId } : {}),
  };
  return apiRequest(server, `${base}/${segment(id)}`, conditional(options, 'PUT', body));
}

export async function layerCommand(context: CliContext, operation: string, args: string[], options: ContentOptions) {
  if (operation === 'validate') return { ok: true, document: await validateLayer(args[0]) };
  const server = await connection(
    context,
    ['import', 'replace', 'copy', 'delete'].includes(operation) ? 'write' : 'admin',
  );
  const base = 'api/admin/overlays/layers';
  if (operation === 'list') return apiRequest(server, base);
  if (operation === 'import') return apiRequest(server, base, jsonRequest('POST', await validateLayer(args[0])));
  const id = segment(args[0]);
  if (operation === 'export') {
    const document = await apiRequest(
      server,
      `${base}/${id}${options.revision ? `?revision=${options.revision}` : ''}`,
    );
    if (options.output) {
      await fs.writeFile(options.output, JSON.stringify(document, null, 2) + '\n');
      return { ok: true, file: path.resolve(options.output) };
    }
    return document;
  }
  if (operation === 'revisions') return apiRequest(server, `${base}/${id}/revisions`);
  if (operation === 'copy')
    return apiRequest(server, `${base}/${id}/copy`, jsonRequest('POST', options.name ? { name: options.name } : {}));
  if (operation === 'delete') return apiRequest(server, `${base}/${id}`, conditional(options, 'DELETE'));
  const document = await validateLayer(args[1]);
  return apiRequest(
    server,
    `${base}/${id}`,
    conditional(options, 'PUT', { ...document, layerId: args[0], revision: (options.ifMatch ?? 0) + 1 }),
  );
}

export async function bindingCommand(context: CliContext, operation: string, options: ContentOptions) {
  const server = await connection(
    context,
    operation === 'manifest' ? 'public' : operation === 'bindings' ? 'admin' : 'write',
  );
  const map = segment(options.map!);
  if (operation === 'manifest') {
    const { parseResourceViewHead } = await import('@violet-map/core/resources');
    const head = parseResourceViewHead(await apiRequest(server, 'api/resources/views/current'));
    return apiRequest(
      server,
      `api/maps/${map}/overlays?dimension=${encodeURIComponent(normalizeContentDimension(options.dimension))}&viewId=${encodeURIComponent(head.viewId)}`,
    );
  }
  const base = `api/admin/maps/${map}/bindings`;
  if (operation === 'bindings') return apiRequest(server, base);
  const binding = segment(options.binding!);
  return apiRequest(
    server,
    `${base}/${binding}`,
    conditional(
      options,
      operation === 'unbind' ? 'DELETE' : 'PUT',
      operation === 'unbind'
        ? undefined
        : {
            bindingId: options.binding,
            layerId: contentId(options.layer),
            dimension: normalizeContentDimension(options.dimension),
            enabled: !options.disabled,
            order: options.order ?? 0,
          },
    ),
  );
}

export async function mediaCommand(context: CliContext, operation: string, args: string[], options: ContentOptions) {
  const server = await connection(context, ['import', 'delete'].includes(operation) ? 'write' : 'admin');
  const base = 'api/admin/media';
  if (operation === 'list') return apiRequest(server, base);
  if (operation === 'import') {
    const bytes = await fs.readFile(args[0]);
    const types: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.glb': 'model/gltf-binary',
    };
    const type = options.type ?? types[path.extname(args[0]).toLowerCase()];
    if (!type) throw new Error('Specify a supported --type for media');
    const url = options.asset ? `${base}/${segment(options.asset)}/versions` : base;
    const headers: Record<string, string> = { 'content-type': type };
    if (options.asset) {
      conditional(options, 'POST');
      headers['if-match'] = revisionTag(options.ifMatch!);
    }
    return apiRequest(server, `${url}?name=${encodeURIComponent(options.name ?? path.basename(args[0]))}`, {
      method: 'POST',
      headers,
      body: bytes,
    });
  }
  const id = segment(args[0]);
  if (operation === 'show') return apiRequest(server, `${base}/${id}`);
  if (operation === 'versions') return apiRequest(server, `${base}/${id}/versions`);
  return apiRequest(
    server,
    `${base}/${id}${options.version ? `/versions/${segment(options.version)}` : ''}`,
    conditional(options, 'DELETE'),
  );
}
