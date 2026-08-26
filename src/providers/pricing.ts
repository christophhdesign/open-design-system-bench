// Cost estimate from captured token usage, for any provider.
//
// Pricing comes from an optional pricing-catalog.json at the package root — we
// never invent a rate. Supply one to get cost columns in reports; without it,
// costs simply read as unavailable. Expected shape:
//   { "data": [ { "id", "name", "pricing": { "input_cost_per_token",
//     "output_cost_per_token" }, "max_tokens" }, ... ] }
// Models absent from the catalog return undefined so the
// report can show tokens without a fake dollar figure.

import { existsSync, readFileSync } from 'node:fs';
import { paths } from '../config.ts';
import type { TokenUsage } from '../types.ts';

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken?: number;
}

export interface PricedModel {
  id: string;
  name: string;
  available?: boolean;
  updated?: number;
  pricing: ModelPricing;
  /** Advertised completion cap from the catalog (`max_tokens`). */
  maxTokens?: number;
}

interface PricingCatalogEntry {
  id?: unknown;
  name?: unknown;
  available?: unknown;
  updated?: unknown;
  max_tokens?: unknown;
  pricing?: {
    input_cost_per_token?: unknown;
    output_cost_per_token?: unknown;
    cache_read_cost_per_token?: unknown;
  };
}

/** Used when the catalog has no row (or no max_tokens) for this model name. */
export const FALLBACK_MAX_TOKENS = 128_000;

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toPricedModel(entry: PricingCatalogEntry): PricedModel | undefined {
  if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || !entry.pricing) return undefined;
  const inputCostPerToken = asFiniteNumber(entry.pricing.input_cost_per_token);
  const outputCostPerToken = asFiniteNumber(entry.pricing.output_cost_per_token);
  if (inputCostPerToken == null || outputCostPerToken == null) return undefined;
  const cacheReadCostPerToken = asFiniteNumber(entry.pricing.cache_read_cost_per_token);
  const maxTokens = asFiniteNumber(entry.max_tokens);
  return {
    id: entry.id,
    name: entry.name,
    available: entry.available === true,
    updated: asFiniteNumber(entry.updated),
    pricing: {
      inputCostPerToken,
      outputCostPerToken,
      ...(cacheReadCostPerToken != null ? { cacheReadCostPerToken } : {}),
    },
    ...(maxTokens != null && maxTokens > 0 ? { maxTokens } : {}),
  };
}

/**
 * Strips routing suffixes ("(Trusted)"), date stamps ("0731" / "0813"), and
 * Gateway region tags ("EU" / "US" / "OTHER") so an alias like
 * "GPT 5.6 Luna EU (Trusted)" matches the catalog row "GPT 5.6 Luna".
 */
export function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/\b(eu|us|other)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function rankMatch(a: PricedModel, b: PricedModel): number {
  if (a.available !== b.available) return a.available ? -1 : 1;
  return (b.updated ?? 0) - (a.updated ?? 0);
}

/**
 * Completion budget for a chat call: the model's advertised `max_tokens` from
 * the pricing catalog when we have a row, otherwise {@link FALLBACK_MAX_TOKENS}.
 * Callers must not clamp this down — thinking models (Gemini Flash) spend a
 * large share of the budget on reasoning before they emit the file JSON, and
 * a 32k cap truncated them mid-string.
 */
export function resolveMaxTokens(model: string, models?: PricedModel[]): number {
  const catalog = models ?? loadPricingCatalog();
  const priced = findPricedModel(catalog, model);
  if (priced?.maxTokens != null && priced.maxTokens > 0) return priced.maxTokens;
  return FALLBACK_MAX_TOKENS;
}

export function findPricedModel(models: PricedModel[], query: string): PricedModel | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const byId = models.find((m) => m.id === q);
  if (byId) return byId;

  const nq = normalizeModelName(q);
  if (!nq) return undefined;
  const matches = models.filter((m) => normalizeModelName(m.name) === nq);
  if (matches.length === 0) return undefined;
  return [...matches].sort(rankMatch)[0];
}

export function computeCostUsd(pricing: ModelPricing, usage: TokenUsage): number {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const billedInput = Math.max(0, usage.inputTokens - cacheRead);
  const cacheRate = pricing.cacheReadCostPerToken ?? pricing.inputCostPerToken;
  return billedInput * pricing.inputCostPerToken + cacheRead * cacheRate + usage.outputTokens * pricing.outputCostPerToken;
}

let cachedModels: PricedModel[] | undefined;

export function loadPricingCatalog(catalogPath: string = paths.pricingCatalog): PricedModel[] {
  if (catalogPath === paths.pricingCatalog && cachedModels) return cachedModels;
  if (!existsSync(catalogPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    return [];
  }
  const data = parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const models = data
    .map((entry) => (entry && typeof entry === 'object' ? toPricedModel(entry as PricingCatalogEntry) : undefined))
    .filter((m): m is PricedModel => m != null);
  if (catalogPath === paths.pricingCatalog) cachedModels = models;
  return models;
}

/** Best-effort USD estimate. Undefined when the model has no catalog rate. */
/**
 * Price a model from the pricing catalog. Provider-agnostic on purpose: whether
 * a cell can be priced depends only on whether its model is in the catalog, not
 * on which gateway served it.
 */
export function estimateApiCostUsd(
  model: string,
  usage: TokenUsage,
  models?: PricedModel[],
): number | undefined {
  const catalog = models ?? loadPricingCatalog();
  const priced = findPricedModel(catalog, model);
  if (!priced) return undefined;
  return computeCostUsd(priced.pricing, usage);
}

/**
 * Price a qualified cell model string ("gateway:Some Model EU") from
 * captured token usage. Used when a record has tokens but no stored costUsd
 * (catalog alias missed at generate time).
 */
export function estimateCostFromModelSpec(
  modelSpec: string,
  usage: TokenUsage,
  models?: PricedModel[],
): number | undefined {
  const idx = modelSpec.indexOf(':');
  const prefix = idx === -1 ? '' : modelSpec.slice(0, idx);
  const name = idx === -1 ? modelSpec : modelSpec.slice(idx + 1);
  if (prefix) {
    return estimateApiCostUsd(name, usage, models);
  }
  const catalog = models ?? loadPricingCatalog();
  const priced = findPricedModel(catalog, modelSpec);
  if (!priced) return undefined;
  return computeCostUsd(priced.pricing, usage);
}

export function recordCostUsd(rec: {
  cell: { model: string };
  agentMeta?: { costUsd?: number; inputTokens?: number; outputTokens?: number };
}): number | undefined {
  const stored = rec.agentMeta?.costUsd;
  if (stored != null && Number.isFinite(stored)) return stored;
  if (rec.agentMeta?.inputTokens == null && rec.agentMeta?.outputTokens == null) return undefined;
  return estimateCostFromModelSpec(rec.cell.model, {
    inputTokens: rec.agentMeta?.inputTokens ?? 0,
    outputTokens: rec.agentMeta?.outputTokens ?? 0,
  });
}
