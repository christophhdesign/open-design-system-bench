// Minimal, dependency-free HTTP clients for the two chat-completion wire
// formats this bench needs: OpenAI-compatible chat/completions and the
// Anthropic Messages API. No provider SDKs — global fetch + node:http only —
// so any OpenAI-compatible gateway (a custom entry the operator
// adds to bench.config.json "providers") works without a new dependency.
//
// This module never talks to a real provider in tests: src/providers/providers.test.ts
// points `baseUrl` at a local node:http mock server instead.

import type { BenchConfig, ProviderConfig, TokenUsage } from '../types.ts';
import { UsageLimitError, looksLikeUsageLimit } from '../agents/errors.ts';
import { resolveMaxTokens } from './pricing.ts';

export interface ResolvedProvider {
  id: string;
  kind: ProviderConfig['kind'];
  baseUrl: string;
  apiKey: string;
  /** See ProviderConfig.stream ('openai' kind only). */
  stream?: boolean;
}

export interface ChatRequest {
  system?: string;
  user: string;
  model: string;
  maxTokens?: number;
  jsonSchema?: { name: string; schema: object };
  /** Lets callers (api-oneshot's timeoutMs, judge's timeoutMs) abort the HTTP call. */
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  json?: unknown;
  /** Present when the provider returned a usage object we could parse. */
  usage?: TokenUsage;
}

const ANTHROPIC_VERSION = '2023-06-01';
const BODY_SNIPPET_LEN = 500;

function asCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

/**
 * Normalizes OpenAI-shaped (`prompt_tokens` / `completion_tokens`) and
 * Anthropic-shaped (`input_tokens` / `output_tokens`) usage objects. Returns
 * undefined when the envelope has no recognizable counts — some gateways omit
 * usage entirely.
 */
export function parseUsage(envelope: unknown): TokenUsage | undefined {
  if (!envelope || typeof envelope !== 'object') return undefined;
  const raw = (envelope as { usage?: unknown }).usage;
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;

  const prompt = asCount(rec.prompt_tokens);
  const completion = asCount(rec.completion_tokens);
  const input = asCount(rec.input_tokens);
  const output = asCount(rec.output_tokens);
  const cacheRead =
    asCount(rec.cache_read_input_tokens) ??
    (rec.prompt_tokens_details && typeof rec.prompt_tokens_details === 'object'
      ? asCount((rec.prompt_tokens_details as Record<string, unknown>).cached_tokens)
      : undefined);
  const cacheCreation = asCount(rec.cache_creation_input_tokens);

  if (prompt != null || completion != null) {
    return {
      inputTokens: prompt ?? 0,
      outputTokens: completion ?? 0,
      ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
    };
  }
  if (input != null || output != null) {
    return {
      inputTokens: (input ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0),
      outputTokens: output ?? 0,
      ...(cacheRead != null ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheCreation != null ? { cacheCreationTokens: cacheCreation } : {}),
    };
  }
  return undefined;
}

/** Reads apiKey from process.env[apiKeyEnv]; throws a clear, actionable error when missing. */
export function resolveProvider(id: string, bench: BenchConfig): ResolvedProvider {
  const cfg = bench.providers?.[id];
  if (!cfg) {
    const known = Object.keys(bench.providers ?? {}).join(', ') || '(none configured)';
    throw new Error(`unknown provider "${id}" (known: ${known}) — add it to bench.config.json "providers"`);
  }
  const apiKey = process.env[cfg.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `provider "${id}" requires ${cfg.apiKeyEnv} to be set in the environment ` +
        `(kind: ${cfg.kind}, baseUrl: ${cfg.baseUrl})`,
    );
  }
  return { id, kind: cfg.kind, baseUrl: cfg.baseUrl, apiKey, ...(cfg.stream ? { stream: true } : {}) };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function httpError(status: number, url: string, bodyText: string): Error {
  const snippet = bodyText.slice(0, BODY_SNIPPET_LEN);
  if (status === 429 || looksLikeUsageLimit(bodyText)) return new UsageLimitError(`HTTP ${status} from ${url}: ${snippet}`);
  // A provider rejecting the completion budget means the model has no
  // pricing-catalog row, so resolveMaxTokens sent the generic fallback.
  const hint =
    status === 400 && /max_?(output_|completion_)?tokens/i.test(bodyText)
      ? ' (the model is missing from pricing-catalog.json, so the fallback max_tokens was sent; add its row to send its real cap)'
      : '';
  return new Error(`HTTP ${status} from ${url}: ${snippet}${hint}`);
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown; bodyText: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const bodyText = await res.text();
  let json: unknown;
  try {
    json = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) throw httpError(res.status, url, bodyText);

  return { status: res.status, json, bodyText };
}

/**
 * Streams an OpenAI-compatible chat completion (SSE) and reassembles it into
 * the non-streaming envelope shape, so chatCompleteOpenAi does not care which
 * path ran. Exists because a gateway that buffers whole completions times out
 * on long generations; with bytes flowing it does not. Usage arrives in the
 * final chunk when `stream_options.include_usage` is set.
 */
async function postSse(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw httpError(res.status, url, await res.text());

  let content = '';
  let finishReason: string | undefined;
  let usage: unknown;
  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let evt: { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: string }>; usage?: unknown };
    try {
      evt = JSON.parse(data);
    } catch {
      return; // keep-alive or malformed chunk
    }
    const choice = evt.choices?.[0];
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (evt.usage) usage = evt.usage;
  };
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  handleLine(buf.trim());
  return { json: { choices: [{ message: { content }, finish_reason: finishReason }], usage } };
}

// ---------------------------------------------------------------------------
// kind: 'openai' — OpenAI-compatible chat completions
// ---------------------------------------------------------------------------

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
}

/**
 * Parse a model response that should be a JSON object but may arrive dressed
 * up: wrapped in ```json fences, prefixed with prose, or with trailing
 * commentary. Gateways don't all enforce response_format, and some models
 * (seen live behind an OpenAI-compatible gateway) fence their JSON regardless. Returns
 * undefined when no parseable object can be found.
 */
export function extractJsonPayload(text: string): unknown {
  const raw = text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to tolerant paths */
  }
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(raw.slice(first, last + 1));
    } catch {
      /* fall through */
    }
    // A stray opening brace on its own line before the real object
    // (`{\n{"files": ...}`): seen repeatedly from one open-weights model
    // behind a gateway, with finish_reason=stop and the payload otherwise
    // complete. Same spirit as tolerating fences: the wrapper is the glitch,
    // not the files.
    const second = raw.indexOf('{', first + 1);
    if (second > first && second < last && /^\{\s*$/.test(raw.slice(first, second))) {
      try {
        return JSON.parse(raw.slice(second, last + 1));
      } catch {
        /* give up */
      }
    }
  }
  return undefined;
}

async function chatCompleteOpenAi(provider: ResolvedProvider, req: ChatRequest): Promise<ChatResponse> {
  const url = joinUrl(provider.baseUrl, '/chat/completions');
  const messages: Array<{ role: string; content: string }> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  messages.push({ role: 'user', content: req.user });

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? resolveMaxTokens(req.model),
  };
  const jsonSchema = req.jsonSchema;
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: jsonSchema.name, schema: jsonSchema.schema, strict: true },
    };
  }

  if (provider.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  const headers = { authorization: `Bearer ${provider.apiKey}` };
  const { json } = provider.stream ? await postSse(url, headers, body, req.signal) : await postJson(url, headers, body, req.signal);
  const envelope = json as OpenAiChatResponse | undefined;
  const choice = envelope?.choices?.[0];
  const content = choice?.message?.content ?? '';
  const finishReason = choice?.finish_reason;
  const usage = parseUsage(json);

  if (jsonSchema) {
    const parsed = extractJsonPayload(content);
    if (parsed === undefined) {
      throw new Error(
        `openai-compatible provider "${provider.id}": response content was not valid JSON ` +
          `(len=${content.length}, finish=${finishReason ?? '?'}, ` +
          `first 200: ${content.slice(0, 200)} last 200: ${content.slice(-200)})`,
      );
    }
    return { text: content, json: parsed, usage };
  }
  return { text: content, usage };
}

// ---------------------------------------------------------------------------
// kind: 'anthropic' — Anthropic Messages API
// ---------------------------------------------------------------------------

interface AnthropicContentBlock {
  type: string;
  text?: string;
  input?: unknown;
  name?: string;
}
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
}

async function chatCompleteAnthropic(provider: ResolvedProvider, req: ChatRequest): Promise<ChatResponse> {
  const url = joinUrl(provider.baseUrl, '/v1/messages');

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? resolveMaxTokens(req.model),
    messages: [{ role: 'user', content: req.user }],
  };
  if (req.system) body.system = req.system;
  const jsonSchema = req.jsonSchema;
  if (jsonSchema) {
    body.tools = [
      {
        name: jsonSchema.name,
        description: 'Return the structured result for this request.',
        input_schema: jsonSchema.schema,
      },
    ];
    body.tool_choice = { type: 'tool', name: jsonSchema.name };
  }

  const { json } = await postJson(
    url,
    { 'x-api-key': provider.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    body,
    req.signal,
  );
  const envelope = json as AnthropicMessagesResponse | undefined;
  const blocks = envelope?.content ?? [];
  const usage = parseUsage(json);

  if (jsonSchema) {
    const schemaName = jsonSchema.name;
    const toolUse = blocks.find((b) => b.type === 'tool_use' && b.name === schemaName);
    if (!toolUse) {
      throw new Error(`anthropic provider "${provider.id}": no tool_use block named "${schemaName}" in response`);
    }
    return { text: JSON.stringify(toolUse.input), json: toolUse.input, usage };
  }

  const text = blocks
    .filter((b): b is AnthropicContentBlock & { text: string } => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return { text, usage };
}

// ---------------------------------------------------------------------------
// Public entry point — routes by provider.kind
// ---------------------------------------------------------------------------

export async function chatComplete(provider: ResolvedProvider, req: ChatRequest): Promise<ChatResponse> {
  switch (provider.kind) {
    case 'openai':
      return chatCompleteOpenAi(provider, req);
    case 'anthropic':
      return chatCompleteAnthropic(provider, req);
    default: {
      const exhaustive: never = provider.kind;
      throw new Error(`unknown provider kind "${String(exhaustive)}"`);
    }
  }
}
