// Offline verification for the multi-provider / bring-your-own-key support.
// Every test here talks to a local node:http mock server on 127.0.0.1 — no
// live calls to any real provider are made or attempted.

import { test } from 'node:test';

import { FALLBACK_MAX_TOKENS } from './pricing.ts';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BenchConfig } from '../types.ts';
import { chatComplete, parseUsage, resolveProvider, type ResolvedProvider } from './client.ts';
import { parseModelSpec } from './model-spec.ts';
import { UsageLimitError } from '../agents/errors.ts';
import { generateWithResolvedProvider } from '../agents/api-oneshot.ts';

// ---------------------------------------------------------------------------
// Mock HTTP server helper
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: unknown;
}

/** Starts a node:http server on 127.0.0.1 that replays `respond` for every request it captures. */
async function startMockServer(
  respond: (req: CapturedRequest, res: ServerResponse) => void,
): Promise<{ baseUrl: string; server: Server; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const captured: CapturedRequest = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(captured);
      respond(captured, res);
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind to a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, requests };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

// ---------------------------------------------------------------------------
// (a) kind: 'openai' — headers, path, response_format, parsed json
// ---------------------------------------------------------------------------

test('chatComplete (openai kind) sends Authorization + /chat/completions + response_format, and parses json_schema content', async () => {
  const { baseUrl, server, requests } = await startMockServer((_req, res) => {
    sendJson(res, 200, {
      choices: [{ message: { content: JSON.stringify({ hello: 'world' }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    });
  });

  try {
    const provider: ResolvedProvider = { id: 'openai', kind: 'openai', baseUrl, apiKey: 'sk-test-123' };
    const result = await chatComplete(provider, {
      system: 'be helpful',
      user: 'say hi',
      model: 'gpt-5.2',
      jsonSchema: { name: 'greeting', schema: { type: 'object', properties: { hello: { type: 'string' } } } },
    });

    assert.equal(requests.length, 1);
    const req = requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer sk-test-123');
    const body = req.body as Record<string, unknown>;
    assert.equal(body.model, 'gpt-5.2');
    assert.equal(body.max_tokens, 128000);
    assert.ok(body.response_format, 'expected response_format to be present');
    assert.deepEqual(result.json, { hello: 'world' });
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40 });
  } finally {
    await stopServer(server);
  }
});

// ---------------------------------------------------------------------------
// (b) kind: 'anthropic' — headers, path, tool_choice, parsed tool_use input
// ---------------------------------------------------------------------------

test('chatComplete (anthropic kind) sends x-api-key + anthropic-version + /v1/messages + forced tool_choice, and parses tool_use input', async () => {
  const { baseUrl, server, requests } = await startMockServer((_req, res) => {
    sendJson(res, 200, {
      content: [{ type: 'tool_use', name: 'greeting', input: { hello: 'world' } }],
      usage: { input_tokens: 80, output_tokens: 12, cache_read_input_tokens: 200 },
    });
  });

  try {
    const provider: ResolvedProvider = { id: 'gw-anthropic', kind: 'anthropic', baseUrl, apiKey: 'gw-abc' };
    const result = await chatComplete(provider, {
      system: 'be helpful',
      user: 'say hi',
      model: 'claude-sonnet-5',
      jsonSchema: { name: 'greeting', schema: { type: 'object', properties: { hello: { type: 'string' } } } },
    });

    assert.equal(requests.length, 1);
    const req = requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'gw-abc');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    const body = req.body as Record<string, unknown>;
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'greeting' });
    assert.equal(body.max_tokens, 128000);
    assert.deepEqual(result.json, { hello: 'world' });
    assert.deepEqual(result.usage, { inputTokens: 280, outputTokens: 12, cacheReadTokens: 200 });
  } finally {
    await stopServer(server);
  }
});

// ---------------------------------------------------------------------------
// (c) 429 + rate-limit body -> UsageLimitError
// ---------------------------------------------------------------------------

test('parseUsage reads OpenAI and Anthropic shapes and ignores empty envelopes', () => {
  assert.equal(parseUsage({ choices: [] }), undefined);
  assert.deepEqual(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 3 } }), {
    inputTokens: 10,
    outputTokens: 3,
  });
  assert.deepEqual(
    parseUsage({
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
    }),
    { inputTokens: 100, outputTokens: 5, cacheReadTokens: 40 },
  );
  assert.deepEqual(
    parseUsage({ usage: { input_tokens: 7, output_tokens: 2, cache_creation_input_tokens: 11 } }),
    { inputTokens: 18, outputTokens: 2, cacheCreationTokens: 11 },
  );
});

test('chatComplete throws UsageLimitError on a 429 rate-limit response', async () => {
  const { baseUrl, server } = await startMockServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded, please retry later' } }));
  });

  try {
    const provider: ResolvedProvider = { id: 'openai', kind: 'openai', baseUrl, apiKey: 'sk-test' };
    await assert.rejects(
      () => chatComplete(provider, { user: 'hi', model: 'gpt-5.2' }),
      (err: unknown) => err instanceof UsageLimitError,
    );
  } finally {
    await stopServer(server);
  }
});

test('chatComplete throws a plain Error (not UsageLimitError) on an ordinary 500', async () => {
  const { baseUrl, server } = await startMockServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'internal server error' } }));
  });

  try {
    const provider: ResolvedProvider = { id: 'openai', kind: 'openai', baseUrl, apiKey: 'sk-test' };
    await assert.rejects(
      () => chatComplete(provider, { user: 'hi', model: 'gpt-5.2' }),
      (err: unknown) => err instanceof Error && !(err instanceof UsageLimitError) && /HTTP 500/.test(err.message),
    );
  } finally {
    await stopServer(server);
  }
});

// ---------------------------------------------------------------------------
// resolveProvider: env var presence + error messages
// ---------------------------------------------------------------------------

test('resolveProvider reads the apiKey from the configured env var', () => {
  const bench: BenchConfig = {
    profiles: {},
    providers: { fakeprov: { kind: 'openai', baseUrl: 'http://example.invalid', apiKeyEnv: 'FAKEPROV_TEST_KEY' } },
    defaults: {
      agent: 'claude-code',
      generatorModel: 'sonnet',
      judgeModel: 'haiku',
      taskTimeoutSec: 60,
      judgeTimeoutSec: 60,
      concurrency: 1,
      judgeSamples: 1,
    },
    ci: { maxScoreDrop: 5, maxErroredCellRatio: 0.2 },
  };

  delete process.env.FAKEPROV_TEST_KEY;
  assert.throws(() => resolveProvider('fakeprov', bench), /FAKEPROV_TEST_KEY/);

  process.env.FAKEPROV_TEST_KEY = 'secret-value';
  try {
    const resolved = resolveProvider('fakeprov', bench);
    assert.equal(resolved.apiKey, 'secret-value');
    assert.equal(resolved.kind, 'openai');
  } finally {
    delete process.env.FAKEPROV_TEST_KEY;
  }

  assert.throws(() => resolveProvider('does-not-exist', bench), /unknown provider "does-not-exist"/);
});

// ---------------------------------------------------------------------------
// (d) parseModelSpec
// ---------------------------------------------------------------------------

test('parseModelSpec', () => {
  const bench: BenchConfig = {
    profiles: {},
    providers: {
      openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
      gateway: { kind: 'openai', baseUrl: 'https://gateway.example/v1', apiKeyEnv: 'GATEWAY_API_KEY' },
    },
    defaults: {
      agent: 'claude-code',
      generatorModel: 'sonnet',
      judgeModel: 'haiku',
      taskTimeoutSec: 60,
      judgeTimeoutSec: 60,
      concurrency: 1,
      judgeSamples: 1,
    },
    ci: { maxScoreDrop: 5, maxErroredCellRatio: 0.2 },
  };

  assert.deepEqual(parseModelSpec('sonnet', bench), { model: 'sonnet' });
  assert.deepEqual(parseModelSpec('openai:gpt-5.2', bench), { provider: 'openai', model: 'gpt-5.2' });
  assert.deepEqual(parseModelSpec('weird:name', bench), { model: 'weird:name' });
  assert.deepEqual(parseModelSpec('gateway:GPT 5.6 Sol', bench), { provider: 'gateway', model: 'GPT 5.6 Sol' });
});

// ---------------------------------------------------------------------------
// (e) api-oneshot path-safety: unsafe paths are rejected, safe ones written
// ---------------------------------------------------------------------------

test('api-oneshot generateWithResolvedProvider only writes files that stay under src/ inside the workspace', async () => {
  const { baseUrl, server } = await startMockServer((_req, res) => {
    sendJson(res, 200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              files: [
                { path: '../evil.ts', content: 'should not be written' },
                { path: 'src/task/index.tsx', content: 'export function TaskScreen() { return null; }' },
              ],
            }),
          },
        },
      ],
    });
  });

  const scratchRoot = mkdtempSync(join(tmpdir(), 'agent-evals-api-oneshot-test-'));
  const workspaceDir = join(scratchRoot, 'workspace');
  const transcriptPath = join(scratchRoot, 'transcript.jsonl');

  try {
    const provider: ResolvedProvider = { id: 'test-provider', kind: 'openai', baseUrl, apiKey: 'sk-test' };
    const result = await generateWithResolvedProvider(
      {
        workspaceDir,
        prompt: 'Implement the task.',
        model: 'gpt-5.2',
        provider: 'test-provider',
        addDirs: [],
        timeoutMs: 10_000,
        transcriptPath,
      },
      provider,
    );

    assert.equal(result.ok, true);

    // The escaping path must NOT exist anywhere under scratchRoot's parent —
    // check the literal resolved location a naive join() would have used.
    const evilPath = join(scratchRoot, 'evil.ts');
    assert.equal(existsSyncSafe(evilPath), false, 'escaping path must not have been written');

    const safePath = join(workspaceDir, 'src', 'task', 'index.tsx');
    assert.equal(existsSyncSafe(safePath), true, 'safe path must have been written');
    assert.equal(readFileSync(safePath, 'utf8'), 'export function TaskScreen() { return null; }');

    assert.ok(result.resultText?.includes('wrote 1 file'));
    assert.ok(result.resultText?.includes('rejected 1 unsafe path'));
  } finally {
    await stopServer(server);
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

test('api-oneshot captures usage tokens, and leaves cost unset without a pricing catalog', async () => {
  const { baseUrl, server } = await startMockServer((_req, res) => {
    sendJson(res, 200, {
      choices: [
        {
          message: {
            content: JSON.stringify({
              files: [{ path: 'src/task/index.tsx', content: 'export function TaskScreen() { return null; }' }],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 2000, completion_tokens: 400 },
    });
  });

  const scratchRoot = mkdtempSync(join(tmpdir(), 'agent-evals-api-oneshot-usage-'));
  const workspaceDir = join(scratchRoot, 'workspace');
  const transcriptPath = join(scratchRoot, 'transcript.jsonl');

  try {
    const provider: ResolvedProvider = {
      id: 'gateway',
      kind: 'openai',
      baseUrl,
      apiKey: 'gw-test',
    };
    const result = await generateWithResolvedProvider(
      {
        workspaceDir,
        prompt: 'Implement the task.',
        model: 'DeepSeek V4 Flash (Trusted)',
        provider: 'gateway',
        addDirs: [],
        timeoutMs: 10_000,
        transcriptPath,
      },
      provider,
    );

    assert.equal(result.ok, true);
    assert.equal(result.inputTokens, 2000);
    assert.equal(result.outputTokens, 400);
    // No pricing catalog ships, so cost is deliberately unset rather than guessed.
    assert.equal(result.costUsd, undefined, 'cost stays unset without a pricing catalog');

    const transcript = JSON.parse(readFileSync(transcriptPath, 'utf8')) as { usage?: unknown };
    assert.deepEqual(transcript.usage, { inputTokens: 2000, outputTokens: 400 });
  } finally {
    await stopServer(server);
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

function existsSyncSafe(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}

test('extractJsonPayload tolerates fenced and prose-wrapped JSON', async () => {
  const { extractJsonPayload } = await import('./client.ts');
  assert.deepEqual(extractJsonPayload('{"files":[]}'), { files: [] });
  assert.deepEqual(extractJsonPayload('```json\n{"files":[{"path":"src/task/index.tsx","content":"x"}]}\n```'), {
    files: [{ path: 'src/task/index.tsx', content: 'x' }],
  });
  assert.deepEqual(extractJsonPayload('Here is the implementation:\n```\n{"a":1}\n```\nLet me know!'), { a: 1 });
  assert.deepEqual(extractJsonPayload('Sure! {"a":{"b":2}} — hope that helps.'), { a: { b: 2 } });
  assert.equal(extractJsonPayload('no json here at all'), undefined);
  assert.equal(extractJsonPayload('{"broken": '), undefined);
});

test('chatComplete falls back to the default token cap with no catalog, and honors an explicit override', async () => {
  const { baseUrl, server, requests } = await startMockServer((_req, res) => {
    sendJson(res, 200, { choices: [{ message: { content: 'ok' } }] });
  });

  try {
    const provider: ResolvedProvider = { id: 'gateway', kind: 'openai', baseUrl, apiKey: 'gw-test' };
    await chatComplete(provider, { user: 'hi', model: 'Some Unlisted Model' });
    await chatComplete(provider, { user: 'hi', model: 'Some Unlisted Model', maxTokens: 1024 });
    assert.equal((requests[0]!.body as { max_tokens: number }).max_tokens, FALLBACK_MAX_TOKENS);
    assert.equal((requests[1]!.body as { max_tokens: number }).max_tokens, 1024);
  } finally {
    await stopServer(server);
  }
});

test('chatComplete json_schema error includes length, finish_reason, and tail', async () => {
  const { baseUrl, server } = await startMockServer((_req, res) => {
    sendJson(res, 200, {
      choices: [{ finish_reason: 'length', message: { content: '{"files":[{"path":"src/task/index.tsx","content":"truncated' } }],
    });
  });

  try {
    const provider: ResolvedProvider = { id: 'gateway', kind: 'openai', baseUrl, apiKey: 'gw-test' };
    await assert.rejects(
      () =>
        chatComplete(provider, {
          user: 'hi',
          model: 'Gemini 3.6 Flash (Trusted)',
          jsonSchema: { name: 'generated_files', schema: { type: 'object' } },
        }),
      (err: unknown) =>
        err instanceof Error &&
        /len=\d+/.test(err.message) &&
        /finish=length/.test(err.message) &&
        /last 200:/.test(err.message),
    );
  } finally {
    await stopServer(server);
  }
});
