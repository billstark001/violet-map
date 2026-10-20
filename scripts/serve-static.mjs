import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? process.argv[2] ?? 3305);
const base = process.env.STATIC_BASE_PATH ?? '/';
if (!base.startsWith('/') || !base.endsWith('/') || base.includes('..'))
  throw new Error('STATIC_BASE_PATH must start and end with /');
const apiBaseUrl = process.env.API_BASE_URL ?? process.argv[3];
if (apiBaseUrl !== undefined) await writeFile(path.join(root, 'runtime-config.json'), JSON.stringify({ apiBaseUrl }));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (!pathname.startsWith(base)) {
      res.writeHead(404).end();
      return;
    }
    const relative = pathname.slice(base.length) || 'index.html';
    const file = path.resolve(root, relative);
    if (
      !file.startsWith(root + path.sep) ||
      relative.split('/').includes('..') ||
      !['GET', 'HEAD'].includes(req.method)
    ) {
      res.writeHead(404).end();
      return;
    }
    if (!(await stat(file)).isFile()) {
      res.writeHead(404).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[path.extname(file)] ?? 'application/octet-stream',
      'cache-control':
        relative === 'runtime-config.json' || relative === 'index.html'
          ? 'no-store'
          : 'public, max-age=31536000, immutable',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(port, '0.0.0.0', () => console.log(`Static Violet Map on :${server.address().port}${base}`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    if (!closing) {
      closing = true;
      server.close();
      server.closeIdleConnections();
    }
  });
