import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunResults, isJudgeMissing, judgeSetup } from './aggregate.ts';
import { judgeMismatchWarnings } from './compare.ts';
import { renderReportHtml } from './html.ts';
import type { CellRecord, RunManifest } from '../types.ts';

function rec(over: Partial<CellRecord> & { judged?: boolean }): CellRecord {
  const { judged = true, ...rest } = over;
  const dims: Record<string, { dimension: string; score: number; gate: 'pass'; diffs: [] }> = {
    imports: { dimension: 'imports', score: 100, gate: 'pass', diffs: [] },
  };
  if (judged) dims.judgment = { dimension: 'judgment', score: 80, gate: 'pass', diffs: [] };
  return {
    cell: { system: 'ds', context: 'agents-md', model: 'haiku', agent: 'claude-code' },
    taskId: 't',
    rep: 1,
    status: 'ok',
    result: { overall: 90, gate: 'pass', dimensions: dims, diffs: [] },
    ...rest,
  };
}

const manifest = (label: string): RunManifest => ({
  runId: label,
  label,
  profile: 'full',
  startedAt: '2026-10-27T00:00:00Z',
  nodeVersion: 'v22',
  adapters: {},
  systems: {},
  cells: [],
});

test('a cell is missing its verdict only when ok, unjudged, and not judged-with-nothing-to-grade', () => {
  assert.equal(isJudgeMissing(rec({ judged: false, judgeMissing: 'run with --no-judge' })), true);
  assert.equal(isJudgeMissing(rec({ judged: false })), true, 'older runs: the missing dimension is the signal');
  assert.equal(isJudgeMissing(rec({ judged: false, judgedBy: { model: 'haiku', samples: 1 } })), false, 'every rubric withheld');
  assert.equal(isJudgeMissing(rec({})), false);
  assert.equal(isJudgeMissing({ ...rec({ judged: false }), status: 'agent-error', result: undefined }), false);
});

test('judgeSetup names how a run was judged and how much of it', () => {
  const by = { model: 'haiku', samples: 3 };
  assert.deepEqual(judgeSetup([rec({ judgedBy: by }), rec({ judgedBy: by })]), { label: 'haiku x3', judged: 2, ok: 2, missing: 0 });
  assert.equal(judgeSetup([rec({ judgedBy: by }), rec({ judgedBy: { model: 'haiku', samples: 1 } })]).label, 'haiku x1 + haiku x3');
  assert.deepEqual(judgeSetup([rec({}), rec({ judged: false })]), { label: 'not recorded', judged: 1, ok: 2, missing: 1 });
});

test('compare warns when runs were judged differently or have cells without a verdict', () => {
  const one = buildRunResults(manifest('one'), [rec({ judgedBy: { model: 'haiku', samples: 1 } })]);
  const three = buildRunResults(manifest('three'), [rec({ judgedBy: { model: 'haiku', samples: 3 } }), rec({ judged: false, rep: 2 })]);
  const same = buildRunResults(manifest('same'), [rec({ judgedBy: { model: 'haiku', samples: 1 } })]);
  assert.deepEqual(judgeMismatchWarnings([one, same]), []);
  const w = judgeMismatchWarnings([one, three]);
  assert.ok(w.some((x) => /judged differently: one \(haiku x1\) vs three \(haiku x3\)/.test(x)));
  assert.ok(w.some((x) => /three: 1 of 2 ok cells have no judge verdict/.test(x)));
});

test('report.html prints the judge and points at --missing', () => {
  const html = renderReportHtml(
    buildRunResults(manifest('r'), [rec({ judgedBy: { model: 'haiku', samples: 3 } }), rec({ judged: false, rep: 2, judgeMissing: 'judge failed: timeout' })]),
  );
  assert.match(html, /haiku x3/);
  assert.match(html, /1 of 2 ok cells judged/);
  assert.match(html, /judge failed: timeout/);
  assert.match(html, /--missing/);
});
