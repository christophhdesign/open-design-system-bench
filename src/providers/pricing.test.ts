import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  computeCostUsd,
  estimateApiCostUsd,
  estimateCostFromModelSpec,
  FALLBACK_MAX_TOKENS,
  findPricedModel,
  recordCostUsd,
  loadPricingCatalog,
  normalizeModelName,
  resolveMaxTokens,
  type PricedModel,
} from './pricing.ts';

const catalog: PricedModel[] = [
  {
    id: 'flash-old',
    name: 'DeepSeek V4 Flash 0731',
    available: true,
    updated: 100,
    pricing: {
      inputCostPerToken: 0.00000022,
      outputCostPerToken: 0.00000066,
      cacheReadCostPerToken: 0.000000007,
    },
  },
  {
    id: 'flash-newer',
    name: 'DeepSeek V4 Flash 0813',
    available: true,
    updated: 200,
    pricing: { inputCostPerToken: 0.0000003, outputCostPerToken: 0.0000009 },
  },
  {
    id: 'unavailable-flash',
    name: 'DeepSeek V4 Flash 0101',
    available: false,
    updated: 300,
    pricing: { inputCostPerToken: 1, outputCostPerToken: 1 },
  },
];

test('normalizeModelName strips (Trusted) and date stamps', () => {
  assert.equal(normalizeModelName('DeepSeek V4 Flash (Trusted)'), 'deepseek v4 flash');
  assert.equal(normalizeModelName('DeepSeek V4 Flash 0731'), 'deepseek v4 flash');
  assert.equal(normalizeModelName('GPT 5.6 Sol'), 'gpt 5 6 sol');
  assert.equal(normalizeModelName('GPT 5.6 Luna EU (Trusted)'), 'gpt 5 6 luna');
  assert.equal(normalizeModelName('DeepSeek V4 Pro 0813 (Trusted)'), 'deepseek v4 pro');
});

test('findPricedModel matches aliases and prefers available + latest updated', () => {
  const hit = findPricedModel(catalog, 'DeepSeek V4 Flash (Trusted)');
  assert.equal(hit?.id, 'flash-newer');
  assert.equal(findPricedModel(catalog, 'flash-old')?.name, 'DeepSeek V4 Flash 0731');
  assert.equal(findPricedModel(catalog, 'no such model'), undefined);
});

test('computeCostUsd bills uncached input at the input rate and cache-read at the cache rate', () => {
  const cost = computeCostUsd(catalog[0]!.pricing, {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 800,
  });
  // 200 uncached * 0.00000022 + 800 cache * 0.000000007 + 500 * 0.00000066
  assert.equal(cost, 200 * 0.00000022 + 800 * 0.000000007 + 500 * 0.00000066);
});

test('estimateApiCostUsd prices any provider whose model is in the catalog', () => {
  const usage = { inputTokens: 1000, outputTokens: 500 };
  // Provider-agnostic: catalog membership is the only condition.
  const priced = estimateApiCostUsd('DeepSeek V4 Flash (Trusted)', usage, catalog);
  assert.ok(priced != null);
  assert.equal(priced, 1000 * 0.0000003 + 500 * 0.0000009);
  assert.equal(estimateApiCostUsd('mystery-model', usage, catalog), undefined);
  assert.equal(estimateApiCostUsd('DeepSeek V4 Flash (Trusted)', usage, []), undefined, 'no catalog, no price');
});

function writeCatalogFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-pricing-'));
  const file = join(dir, 'pricing-catalog.json');
  writeFileSync(
    file,
    JSON.stringify({
      data: [
        { id: 'flash', name: 'Example Flash', pricing: { input_cost_per_token: 0.0000003, output_cost_per_token: 0.0000009 }, max_tokens: 65535 },
        { id: 'luna', name: 'Example Luna', pricing: { input_cost_per_token: 0.00000022, output_cost_per_token: 0.00000132 }, max_tokens: 128000 },
      ],
    }),
  );
  return file;
}

test('loadPricingCatalog parses a catalog file, and tolerates a missing one', () => {
  const models = loadPricingCatalog(writeCatalogFile());
  assert.equal(models.length, 2);
  const hit = findPricedModel(models, 'Example Flash');
  assert.ok(hit, 'expected a catalog match for Example Flash');
  assert.ok(hit!.pricing.inputCostPerToken > 0);
  assert.ok(hit!.pricing.outputCostPerToken > 0);
  // The catalog is optional: absent means "cost unavailable", never a crash.
  assert.deepEqual(loadPricingCatalog(join(tmpdir(), 'odsys-pricing-does-not-exist.json')), []);
});

test('estimateCostFromModelSpec prices a qualified alias that includes a region tag', () => {
  const usage = { inputTokens: 1000, outputTokens: 500 };
  const priced = estimateCostFromModelSpec('gateway:GPT 5.6 Luna EU (Trusted)', usage, [
    {
      id: 'luna',
      name: 'GPT 5.6 Luna',
      available: true,
      pricing: { inputCostPerToken: 0.00000022, outputCostPerToken: 0.00000132 },
    },
  ]);
  assert.equal(priced, 1000 * 0.00000022 + 500 * 0.00000132);
});

test('recordCostUsd returns undefined when no catalog rate is available', () => {
  // With no pricing catalog shipped, an unpriceable record reads as "no cost",
  // which is what the report renders as n/a rather than a fabricated number.
  const cost = recordCostUsd({
    cell: { model: 'gateway:Totally Unknown Model' },
    agentMeta: { inputTokens: 1000, outputTokens: 500 },
  });
  assert.equal(cost, undefined);
});

test('resolveMaxTokens uses the catalog cap and falls back when unknown', () => {
  const models = loadPricingCatalog(writeCatalogFile());
  assert.equal(resolveMaxTokens('Example Flash', models), 65535);
  assert.equal(resolveMaxTokens('Example Luna EU (Trusted)', models), 128000);
  assert.equal(resolveMaxTokens('no-such-model-xyz', models), FALLBACK_MAX_TOKENS);
  assert.equal(
    resolveMaxTokens('mystery', [
      { id: 'mystery', name: 'mystery', pricing: { inputCostPerToken: 1, outputCostPerToken: 1 } },
    ]),
    FALLBACK_MAX_TOKENS,
  );
});
