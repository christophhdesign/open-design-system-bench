import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunResults } from './aggregate.ts';
import { ciCheck, type CiOptions } from './ci.ts';
import type { CellRecord, CellStatus, RunManifest, RunResults } from '../types.ts';

const opts: CiOptions = { maxScoreDrop: 5, maxErroredCellRatio: 0.5, failOn: 'regression' };

function rec(taskId: string, overall: number, over: { status?: CellStatus; judged?: boolean; context?: 'bare' | 'agents-md' } = {}): CellRecord {
  const { status = 'ok', judged = true, context = 'agents-md' } = over;
  const dims: Record<string, { dimension: string; score: number; gate: 'pass'; diffs: [] }> = {
    imports: { dimension: 'imports', score: overall, gate: 'pass', diffs: [] },
  };
  if (judged) dims.judgment = { dimension: 'judgment', score: overall, gate: 'pass', diffs: [] };
  return {
    cell: { system: 'ds', context, model: 'haiku', agent: 'claude-code' },
    taskId,
    rep: 1,
    status,
    ...(status === 'ok' ? { result: { overall, gate: 'pass' as const, dimensions: dims, diffs: [] } } : {}),
  };
}

function run(label: string, records: CellRecord[], paused = false): RunResults {
  const manifest: RunManifest = { runId: label, label, profile: 'full', startedAt: '2026-10-27T00:00:00Z', nodeVersion: 'v22', adapters: {}, systems: {}, cells: [], paused };
  return buildRunResults(manifest, records);
}

const tasks = ['t1', 't2', 't3', 't4', 't5'];
const baseline = run('base', tasks.map((t) => rec(t, 80)));

test('a matching, fully measured run passes and reports full coverage', () => {
  const out = ciCheck(run('cur', tasks.map((t) => rec(t, 80))), baseline, opts);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.coverage, { comparable: 5, matched: 5, unmeasured: [], added: 0 });
  assert.match(out.summary, /5 of 5 comparable cell\(s\) measured \(100%, min 80%\)/);
});

test('a run with no overlap is inconclusive, not a pass', () => {
  const out = ciCheck(run('cur', ['x1', 'x2'].map((t) => rec(t, 10))), baseline, opts);
  assert.equal(out.exitCode, 3);
  assert.match(out.summary, /INCONCLUSIVE: no cell in this run overlaps the baseline/);
  assert.equal(out.coverage!.added, 2);
});

test('too few measured cells is inconclusive', () => {
  const cur = run('cur', [rec('t1', 80), rec('t2', 80), rec('t3', 80), rec('t4', 0, { status: 'agent-error' }), rec('t5', 0, { status: 'timeout' })]);
  const out = ciCheck(cur, baseline, opts);
  assert.equal(out.exitCode, 3, '3 of 5 is under the 80% minimum');
  assert.match(out.summary, /INCONCLUSIVE: too few comparable cells were measured/);
  assert.equal(ciCheck(cur, baseline, { ...opts, minCoverage: 0.6 }).exitCode, 0, 'the minimum is configurable');
});

test('an all-skipped run and a paused run are inconclusive', () => {
  assert.equal(ciCheck(run('cur', tasks.map((t) => rec(t, 0, { status: 'skipped' }))), baseline, opts).exitCode, 3);
  const paused = ciCheck(run('cur', tasks.map((t) => rec(t, 80)), true), baseline, opts);
  assert.equal(paused.exitCode, 3);
  assert.match(paused.summary, /paused/);
});

test('a cell without a verdict is unmeasured where the baseline was judged, never compared', () => {
  // t5's judge failed: its mechanical-only score runs high, and a drop hidden behind it must not pass as data.
  const cur = run('cur', [...tasks.slice(0, 4).map((t) => rec(t, 80)), rec('t5', 99, { judged: false })]);
  const out = ciCheck(cur, baseline, opts);
  assert.equal(out.exitCode, 0, '4 of 5 measured meets the minimum');
  assert.deepEqual(out.coverage!.unmeasured, ['ds_agents-md_haiku::t5']);
  assert.match(out.summary, /unmeasured: ds_agents-md_haiku::t5/);
  // Where the baseline was not judged either, the two are comparable.
  const unjudged = run('base', tasks.map((t) => rec(t, 80, { judged: false })));
  const allUnjudged = run('cur', tasks.map((t) => rec(t, 80, { judged: false })));
  assert.equal(ciCheck(allUnjudged, unjudged, opts).coverage!.matched, 5);
  // The other way round: a judged cell against an unjudged baseline cell would
  // read the judgment's cost as a regression.
  const baseMissing = run('base', [...tasks.slice(0, 4).map((t) => rec(t, 80)), rec('t5', 99, { judged: false })]);
  const reversed = ciCheck(run('cur', tasks.map((t) => rec(t, 80))), baseMissing, opts);
  assert.equal(reversed.exitCode, 0, 'no false regression on t5');
  assert.deepEqual(reversed.coverage!.unmeasured, ['ds_agents-md_haiku::t5']);
});

test('a small run gates against a full baseline on its own cells, and new cells are never regressions', () => {
  const small = ciCheck(run('cur', [rec('t1', 80), rec('t2', 80)]), baseline, opts);
  assert.equal(small.exitCode, 0);
  assert.deepEqual(small.coverage, { comparable: 2, matched: 2, unmeasured: [], added: 0 });
  const grown = ciCheck(run('cur', [...tasks.map((t) => rec(t, 80)), rec('t6', 1)]), baseline, opts);
  assert.equal(grown.exitCode, 0);
  assert.equal(grown.coverage!.added, 1);
});

test('a real drop on a measured cell is still a regression', () => {
  const out = ciCheck(run('cur', [...tasks.slice(0, 4).map((t) => rec(t, 80)), rec('t5', 60)]), baseline, opts);
  assert.equal(out.exitCode, 1);
  assert.match(out.regressions[0]!, /t5/);
});
