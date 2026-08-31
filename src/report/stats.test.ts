// buildReportStats is the only place a report's numbers come from, so its
// arithmetic is tested directly rather than through the rendered blocks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAuditScore } from '../audit/score.ts';
import type { AuditCheckResult } from '../audit/types.ts';
import type { CellRecord, DimensionResult, Gate, RunManifest, SystemConfig } from '../types.ts';
import { buildRunResults } from './aggregate.ts';
import {
  REPORT_OUTLINE,
  buildComparabilityKey,
  buildReportStats,
  headingFor,
  renderStatsBlocks,
} from './stats.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const CONFIG: SystemConfig = {
  root: '/example',
  rootEnv: 'EXAMPLE_ROOT',
  componentsSrc: 'src',
  componentsPkg: '@example/components',
  foundationsPkg: '@example/tokens',
  catalogStrategy: 'docgen',
  agentContext: { agentsMd: ['README.md'] },
};

function dim(dimension: string, score: number, gate: Gate = 'pass'): DimensionResult {
  return { dimension, score, gate, diffs: [] };
}

function record(
  taskId: string,
  context: string,
  overall: number,
  gate: Gate,
  dims: DimensionResult[],
  status: CellRecord['status'] = 'ok',
): CellRecord {
  const cell = { system: 'sys', context: context as never, model: 'm', agent: 'a' };
  if (status !== 'ok') return { cell, taskId, rep: 1, status };
  return {
    cell,
    taskId,
    rep: 1,
    status,
    result: {
      overall,
      gate,
      dimensions: Object.fromEntries(dims.map((d) => [d.dimension, d])),
      diffs: [],
    },
  };
}

function manifestFor(records: CellRecord[]): RunManifest {
  return {
    runId: 'run-1',
    profile: 'medium',
    startedAt: '2026-01-01T00:00:00.000Z',
    nodeVersion: 'v22',
    adapters: {},
    systems: {},
    cells: records.map((r) => ({ spec: { ...r.cell, taskId: r.taskId, rep: r.rep }, status: r.status })),
    totalCostUsd: 1.25,
    wallClockMs: 60_000,
  };
}

const NO_CHECKS: AuditCheckResult[] = [];

function statsFor(records: CellRecord[]) {
  const run = buildRunResults(manifestFor(records), records);
  return buildReportStats(run, 'sys', CONFIG, NO_CHECKS, computeAuditScore(NO_CHECKS, run, 'sys'), null);
}

// ---------------------------------------------------------------------------

test('summary statistics over an even number of cells', () => {
  const stats = statsFor([
    record('t1', 'bare', 60, 'fail', [dim('imports', 100), dim('judgment', 20)]),
    record('t1', 'skill', 80, 'review', [dim('imports', 100), dim('judgment', 60)]),
    record('t2', 'bare', 90, 'pass', [dim('imports', 100), dim('judgment', 80)]),
    record('t2', 'skill', 100, 'pass', [dim('imports', 100), dim('judgment', 100)]),
  ]);

  assert.equal(stats.summary.cellCount, 4);
  assert.equal(stats.summary.okCount, 4);
  assert.equal(stats.summary.meanOverall, 82.5);
  // The median of an even set averages the middle two. Taking the upper of the
  // pair is the mistake this exists to prevent.
  assert.equal(stats.summary.medianOverall, 85);
  assert.equal(stats.summary.minOverall, 60);
  assert.equal(stats.summary.maxOverall, 100);
  assert.deepEqual(stats.summary.gateCounts, { pass: 2, review: 1, fail: 1 });
  assert.equal(stats.summary.perfectCells, 1);
  assert.equal(stats.summary.costUsd, 1.25);
  assert.deepEqual(stats.summary.dimensionMeans, { imports: 100, judgment: 65 });
});

test('the median of an odd number of cells is the middle value', () => {
  const stats = statsFor([
    record('t1', 'bare', 10, 'pass', [dim('imports', 10)]),
    record('t2', 'bare', 20, 'pass', [dim('imports', 20)]),
    record('t3', 'bare', 90, 'pass', [dim('imports', 90)]),
  ]);
  assert.equal(stats.summary.medianOverall, 20);
});

test('errored cells are counted but excluded from every mean', () => {
  const stats = statsFor([
    record('t1', 'bare', 100, 'pass', [dim('imports', 100)]),
    record('t2', 'bare', 0, 'pass', [], 'agent-error'),
    record('t3', 'bare', 0, 'pass', [], 'timeout'),
  ]);

  assert.equal(stats.summary.cellCount, 3);
  assert.equal(stats.summary.okCount, 1);
  // aggregate.ts omits zero-ok cells entirely, so this count has to come from
  // the records rather than from the aggregates array.
  assert.equal(stats.summary.erroredCount, 2);
  assert.equal(stats.summary.meanOverall, 100);
  assert.deepEqual(stats.summary.gateCounts, { pass: 1, review: 0, fail: 0 });
});

test('a cell weighted to just under 100 still counts as perfect', () => {
  const stats = statsFor([record('t1', 'bare', 99.999_999, 'pass', [dim('imports', 100)])]);
  assert.equal(stats.summary.perfectCells, 1);
});

test('byContext splits means and gates, ordered bare then agents-md then skill', () => {
  const stats = statsFor([
    record('t1', 'skill', 80, 'pass', [dim('imports', 80)]),
    record('t1', 'bare', 40, 'fail', [dim('imports', 40)]),
    record('t2', 'bare', 60, 'pass', [dim('imports', 60)]),
    record('t2', 'skill', 100, 'pass', [dim('imports', 100)]),
  ]);

  assert.deepEqual(stats.contexts, ['bare', 'skill']);
  assert.equal(stats.byContext[0].context, 'bare');
  assert.equal(stats.byContext[0].meanOverall, 50);
  assert.deepEqual(stats.byContext[0].gateCounts, { pass: 1, review: 0, fail: 1 });
  assert.equal(stats.byContext[1].meanOverall, 90);
});

test('coverage: a hard failure, a low judgment and a review dimension each become mandatory', () => {
  const stats = statsFor([
    record('t1', 'bare', 63, 'fail', [dim('apiFidelity', 0, 'fail'), dim('judgment', 60)]),
    record('t2', 'bare', 82, 'review', [dim('apiFidelity', 100), dim('judgment', 40, 'review')]),
  ]);

  const keys = stats.coverage.map((c) => c.key);
  assert.ok(keys.includes('cell-fail:sys_bare_m/t1/rep1'));
  assert.ok(keys.includes('judgment-low:sys_bare_m/t2/rep1'));
  assert.ok(keys.includes('review-dimension:judgment'));
  // 60 is the threshold, not below it.
  assert.ok(!keys.includes('judgment-low:sys_bare_m/t1/rep1'));
});

test('coverage: audit checks qualify on a low score, a failing finding, or a vocabulary divergence', () => {
  const checks: AuditCheckResult[] = [
    { id: 'surface', title: 'Enablement surface', score: 35, findings: [] },
    { id: 'export-hygiene', title: 'Export hygiene', score: 100, findings: [] },
    { id: 'catalog-quality', title: 'Catalog quality', score: 95, findings: [{ severity: 'fail', message: 'stale' }] },
    { id: 'vocabulary', title: 'Vocabulary convention-distance', score: 93, findings: [{ severity: 'warn', message: 'TextField' }] },
    { id: 'tokens', title: 'Token machine-readability', score: 88, findings: [{ severity: 'warn', message: 'flat' }] },
  ];
  const records = [record('t1', 'bare', 100, 'pass', [dim('imports', 100)])];
  const run = buildRunResults(manifestFor(records), records);
  const stats = buildReportStats(run, 'sys', CONFIG, checks, computeAuditScore(checks, run, 'sys'), null);

  const keys = stats.coverage.map((c) => c.key);
  assert.ok(keys.includes('audit-check:surface'), 'low score');
  assert.ok(keys.includes('audit-check:catalog-quality'), 'failing finding despite a high score');
  assert.ok(keys.includes('audit-check:vocabulary'), 'divergences despite a high score');
  assert.ok(!keys.includes('audit-check:export-hygiene'), 'clean check');
  assert.ok(!keys.includes('audit-check:tokens'), 'a warn on a non-vocabulary check above threshold');
});

test('artifact paths are normalized to POSIX', () => {
  const records = [record('t1', 'bare', 100, 'pass', [dim('imports', 100)])];
  records[0].artifacts = { dir: 'cells\\sys_bare_m\\t1\\rep1', diffPatch: 'diff.patch' };
  const stats = statsFor(records);
  assert.equal(stats.cells[0].artifactsDir, 'cells/sys_bare_m/t1/rep1');
});

test('the comparability key records everything that makes two runs incomparable', () => {
  const records = [
    record('t1', 'bare', 100, 'pass', [dim('imports', 100)]),
    record('t2', 'skill', 90, 'pass', [dim('imports', 90)]),
  ];
  const run = buildRunResults(manifestFor(records), records);
  const stats = buildReportStats(run, 'sys', CONFIG, NO_CHECKS, computeAuditScore(NO_CHECKS, run, 'sys'), null);
  assert.equal(
    buildComparabilityKey(stats, run),
    'profile=medium;contexts=bare,skill;reps=1;consume=source;fixture=fixtures/sys-app;tasks=2',
  );
});

test('generated numbers are quotable in prose; an unrelated number is not', () => {
  const stats = statsFor([
    record('t1', 'bare', 60, 'fail', [dim('imports', 100), dim('judgment', 20)]),
    record('t1', 'skill', 80, 'pass', [dim('imports', 100), dim('judgment', 60)]),
  ]);
  const allowed = new Set(stats.allowedNumbers);
  assert.ok(allowed.has(70), 'the mean');
  assert.ok(allowed.has(60), 'a cell overall');
  assert.ok(allowed.has(20), 'a dimension score');
  assert.ok(allowed.has(2), 'the cell count');
  assert.ok(allowed.has(40), 'a same-task delta between contexts');
  assert.ok(!allowed.has(61.4), 'an unrelated figure');
});

test('every generated outline section renders a block, and no agent section does', () => {
  const stats = statsFor([record('t1', 'bare', 100, 'pass', [dim('imports', 100)])]);
  const blocks = renderStatsBlocks(stats);
  for (const section of REPORT_OUTLINE) {
    if (section.source === 'generated') {
      assert.ok(blocks[section.number], `missing generated block for ${section.number}`);
      assert.ok(blocks[section.number].trim().length > 0);
    } else {
      assert.equal(blocks[section.number], undefined, `agent section ${section.number} must not be generated`);
    }
  }
});

test('headings number top-level sections with a period and sub-sections without', () => {
  assert.equal(headingFor({ number: '1', title: 'Executive summary', level: 2, source: 'generated' }), '## 1. Executive summary');
  assert.equal(headingFor({ number: '2.1', title: 'What the benchmark does', level: 3, source: 'generated' }), '### 2.1 What the benchmark does');
  assert.equal(headingFor({ number: 'A', title: 'Task suite', level: 2, source: 'generated' }), '## Appendix A - Task suite');
});

test('rendering is deterministic: the same stats render byte-identical blocks', () => {
  const fx = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'example-run.json'), 'utf8'));
  const run = buildRunResults(fx.manifest, fx.records);
  const score = computeAuditScore(fx.checks, run, 'my-system');
  const a = renderStatsBlocks(buildReportStats(run, 'my-system', fx.config, fx.checks, score, fx.extraction));
  const b = renderStatsBlocks(buildReportStats(run, 'my-system', fx.config, fx.checks, score, fx.extraction));
  assert.deepEqual(a, b);
});

test('the extraction block reports the catalog counts, and says so when there is no catalog', () => {
  const records = [record('t1', 'bare', 100, 'pass', [dim('imports', 100)])];
  const run = buildRunResults(manifestFor(records), records);
  const score = computeAuditScore(NO_CHECKS, run, 'sys');
  const extraction = { components: 20, exports: 24, props: 96, cssVars: 120, utilities: 0 };

  const withCatalog = renderStatsBlocks(buildReportStats(run, 'sys', CONFIG, NO_CHECKS, score, extraction))['2.3'];
  for (const [label, value] of Object.entries(extraction)) {
    assert.match(withCatalog, new RegExp(`${label}\\s+${value}`), `2.3 does not report ${label}`);
  }

  const without = renderStatsBlocks(buildReportStats(run, 'sys', CONFIG, NO_CHECKS, score, null))['2.3'];
  assert.match(without, /has not been extracted/);
});

test('the config snapshot redacts the machine-specific checkout path', () => {
  const stats = statsFor([record('t1', 'bare', 100, 'pass', [dim('imports', 100)])]);
  const block = renderStatsBlocks(stats)['2.2'];
  assert.ok(block.includes('"root": "<system checkout>"'));
  assert.ok(!block.includes('/example'));
  assert.ok(!block.includes('EXAMPLE_ROOT'));
});
