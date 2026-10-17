import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { nonSharedByteView } from '../../packages/core/src/http.js';

const source = new Uint8Array(8 * 1024 ** 2 + 16);

source.fill(7);

const bytes = source.subarray(8, source.length - 8);
const expected = createHash('sha256').update(bytes).digest('hex');
const server = serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const body =
      new URL(request.url).pathname === '/copy'
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : nonSharedByteView(bytes);
    return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
  },
});

try {
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const timings = { copy: [] as number[], view: [] as number[] };
  for (let round = 0; round < 25; round++) {
    const names = Object.keys(timings) as (keyof typeof timings)[];
    if (round % 2) names.reverse();
    for (const name of names) {
      const start = performance.now();
      const response = await fetch(`${origin}/${name}`);
      const received = new Uint8Array(await response.arrayBuffer());
      const elapsed = performance.now() - start;
      assert.equal(response.status, 200);
      assert.equal(received.length, bytes.length);
      assert.equal(createHash('sha256').update(received).digest('hex'), expected);
      if (round >= 5) timings[name].push(elapsed);
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        bytes: bytes.length,
        measuredRounds: 20,
        includes: 'Hono Node adapter, HTTP loopback, response consumption; digest validation excluded',
        p50Ms: Object.fromEntries(
          Object.entries(timings).map(([name, times]) => [name, times.toSorted((a, b) => a - b)[10]]),
        ),
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
}
