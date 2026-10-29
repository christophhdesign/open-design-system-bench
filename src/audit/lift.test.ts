import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLift } from './score.ts';
import { buildRunResults } from '../report/aggregate.ts';
import type { CellRecord, ContextLevel, RunManifest } from '../types.ts';

const manifest: RunManifest = { runId: 'r', profile: 'full', startedAt: '2026-10-27T00:00:00Z', nodeVersion: 'v22', adapters: {}, systems: {}, cells: [] };
const rec = (context: ContextLevel, model: string, taskId: string, overall: number): CellRecord => ({
  cell: { system: 'ds', context, model, agent: 'claude-code' },
  taskId,
  rep: 1,
  status: 'ok',
  result: { overall, gate: 'pass', dimensions: {}, diffs: [] },
});
const lift = (records: CellRecord[]) => computeLift(buildRunResults(manifest, records), 'ds');

test('a model present on one side only cannot manufacture lift', () => {
  // Model "weak" ran both ways and gained nothing. Model "strong" ran guided
  // only (its bare cells errored). Unpaired, its 95s used to read as +25 lift.
  const out = lift([
    rec('bare', 'weak', 't1', 60),
    rec('agents-md', 'weak', 't1', 60),
    rec('agents-md', 'strong', 't1', 95),
  ]);
  assert.equal(out.raw, 0);
  assert.match(out.note, /paired over 1 .*1 guided and 0 bare cell\(s\) without a partner/);
});

test('on a balanced matrix paired lift equals the old difference of means', () => {
  const tasks = { t1: [40, 70, 80], t2: [50, 55, 65], t3: [30, 90, 60] } as const;
  const records = Object.entries(tasks).flatMap(([t, [b, a, s]]) => [rec('bare', 'm', t, b), rec('agents-md', 'm', t, a), rec('skill', 'm', t, s)]);
  const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
  const old = mean(Object.values(tasks).flatMap(([, a, s]) => [a, s])) - mean(Object.values(tasks).map(([b]) => b));
  assert.equal(lift(records).raw, Math.round(old * 10) / 10);
});

test('no matched pair withholds lift instead of guessing', () => {
  const out = lift([rec('bare', 'm', 't1', 50), rec('agents-md', 'm', 't2', 90)]);
  assert.equal(out.score, null);
  assert.match(out.note, /Lift needs matched pairs \(1 guided and 1 bare cell\(s\) without a partner/);
});
