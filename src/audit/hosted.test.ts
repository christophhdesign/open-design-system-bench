// Offline verification for the opt-in hosted-surface probe module. Every
// test here talks to a local node:http server on 127.0.0.1 (port 0, so the
// OS assigns a free one) — no live calls to any real host are made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { probeHostedSurface } from './hosted.ts';

async function startServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind to a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

const SMALL_LLMS_TXT = '# Acme UI\n\n- Button\n- Toggle\n- Stack\n';

/** Body well over the 1 MB llms.txt text-capture limit, but under the 8 MB read cap — generated, never committed. */
function bigBody(): string {
  return `# llms-full\n${'x'.repeat(1_200_000)}`;
}

test('probeHostedSurface: found (200), absent (404), and JSON found are reported with byte counts', async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    if (req.url === '/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(SMALL_LLMS_TXT);
    } else if (req.url === '/llms-full.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(bigBody());
    } else if (req.url === '/mcp/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ entries: [{ name: 'Button' }, { name: 'Toggle' }] }));
    } else if (req.url === '/registry.json') {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const surface = await probeHostedSurface(baseUrl);
    assert.equal(surface.docsUrl, baseUrl);
    assert.equal(surface.probes.length, 4);

    const byPath = new Map(surface.probes.map((p) => [p.path, p]));

    const llmsTxt = byPath.get('/llms.txt')!;
    assert.equal(llmsTxt.status, 'found');
    assert.equal(llmsTxt.httpStatus, 200);
    assert.equal(llmsTxt.bytes, Buffer.byteLength(SMALL_LLMS_TXT));
    assert.equal(llmsTxt.text, SMALL_LLMS_TXT);
    assert.equal(llmsTxt.url, `${baseUrl}/llms.txt`);

    const llmsFull = byPath.get('/llms-full.txt')!;
    assert.equal(llmsFull.status, 'found');
    assert.ok((llmsFull.bytes ?? 0) > 1_000_000, `expected llms-full.txt bytes > 1MB, got ${llmsFull.bytes}`);
    // Not the llms.txt path, so text is never captured regardless of size.
    assert.equal(llmsFull.text, undefined);

    const mcpIndex = byPath.get('/mcp/index.json')!;
    assert.equal(mcpIndex.status, 'found');
    assert.ok((mcpIndex.bytes ?? 0) > 0);

    const registry = byPath.get('/registry.json')!;
    assert.equal(registry.status, 'absent');
    assert.equal(registry.httpStatus, 404);
    assert.equal(registry.bytes, undefined);
  } finally {
    await stopServer(server);
  }
});

test('probeHostedSurface: llms.txt over the 1 MB text-capture limit reports bytes but no text', async () => {
  const bigLlms = bigBody();
  const { baseUrl, server } = await startServer((req, res) => {
    if (req.url === '/llms.txt') {
      res.writeHead(200);
      res.end(bigLlms);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    const surface = await probeHostedSurface(baseUrl);
    const llmsTxt = surface.probes.find((p) => p.path === '/llms.txt')!;
    assert.equal(llmsTxt.status, 'found');
    assert.equal(llmsTxt.bytes, Buffer.byteLength(bigLlms));
    assert.equal(llmsTxt.text, undefined, 'text must not be captured over the 1 MB limit');
  } finally {
    await stopServer(server);
  }
});

test('probeHostedSurface: connection failure (server not running) is unreachable, not absent', async () => {
  // Bind and immediately close, so the port is very likely free but nothing
  // is listening on it — a real connection-refused case.
  const { baseUrl, server } = await startServer((_req, res) => res.end());
  await stopServer(server);

  const surface = await probeHostedSurface(baseUrl, { timeoutMs: 2000 });
  for (const probe of surface.probes) {
    assert.equal(probe.status, 'unreachable', `expected ${probe.path} to be unreachable, got ${probe.status}`);
    assert.equal(probe.httpStatus, undefined);
  }
});

test('probeHostedSurface: a route that never responds times out as unreachable, not absent', async () => {
  const { baseUrl, server } = await startServer((req, res) => {
    if (req.url === '/llms.txt') {
      // Never call res.end() — simulates a hung/very slow server.
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const surface = await probeHostedSurface(baseUrl, { timeoutMs: 200 });
    const llmsTxt = surface.probes.find((p) => p.path === '/llms.txt')!;
    assert.equal(llmsTxt.status, 'unreachable');
    assert.equal(llmsTxt.httpStatus, undefined);
    // The other three routes returned instantly as absent (404) — confirms
    // the timeout affected only the hung route.
    const others = surface.probes.filter((p) => p.path !== '/llms.txt');
    for (const p of others) assert.equal(p.status, 'absent');
  } finally {
    await stopServer(server);
  }
});

test('probeHostedSurface: a non-2xx, non-404/410 status (e.g. 500) is unreachable', async () => {
  const { baseUrl, server } = await startServer((_req, res) => {
    res.writeHead(500);
    res.end('server error');
  });

  try {
    const surface = await probeHostedSurface(baseUrl);
    for (const probe of surface.probes) {
      assert.equal(probe.status, 'unreachable');
      assert.equal(probe.httpStatus, 500);
    }
  } finally {
    await stopServer(server);
  }
});

test('probeHostedSurface: fetchImpl injection is honored (no real network touched)', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response('# fake llms.txt', { status: 200 });
  };

  const surface = await probeHostedSurface('https://example.invalid', { fetchImpl: fakeFetch });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((u) => u.startsWith('https://example.invalid/')));
  const llmsTxt = surface.probes.find((p) => p.path === '/llms.txt')!;
  assert.equal(llmsTxt.status, 'found');
  assert.equal(llmsTxt.text, '# fake llms.txt');
});
