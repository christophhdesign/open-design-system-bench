// Synthetic-data verification for the reporting + CI module. No fixtures touch
// disk except the two demo HTML files written at the end, for a human to open.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  CellRecord,
  CellStatus,
  ContextLevel,
  Diff,
  EvalResult,
  Gate,
  SystemId,
  RunManifest,
} from '../types.ts';
import { cellKey } from '../types.ts';
import { buildRunResults, GATE_RANK } from './aggregate.ts';
import { renderCompareHtml } from './compare.ts';
import { ciCheck, type CiOptions } from './ci.ts';
import { renderReportHtml } from './html.ts';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeEvalResult(params: { overall: number; gate: Gate; judgeMessage?: string; judgeFix?: string }): EvalResult {
  const diffs: Diff[] = [];
  if (params.judgeMessage) {
    diffs.push({ dimension: 'judgment', message: params.judgeMessage, fix: params.judgeFix });
  }
  return {
    overall: params.overall,
    gate: params.gate,
    dimensions: {
      imports: { dimension: 'imports', score: params.overall, gate: params.gate, diffs: [] },
      judgment: { dimension: 'judgment', score: params.overall, gate: params.gate, diffs },
    },
    diffs,
  };
}

function makeRecord(params: {
  system: SystemId;
  context: ContextLevel;
  model: string;
  taskId: string;
  rep: number;
  status: CellStatus;
  skipReason?: string;
  overall?: number;
  gate?: Gate;
  judgeMessage?: string;
  judgeFix?: string;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}): CellRecord {
  const cell = { system: params.system, context: params.context, model: params.model, agent: 'claude-code' };
  const rec: CellRecord = {
    cell,
    taskId: params.taskId,
    rep: params.rep,
    status: params.status,
  };
  if (params.skipReason) rec.skipReason = params.skipReason;

  if (params.status === 'ok') {
    rec.agentMeta = {
      durationMs: params.durationMs ?? 60_000,
      costUsd: params.costUsd ?? 0.12,
      numTurns: 6,
      ...(params.inputTokens != null ? { inputTokens: params.inputTokens } : {}),
      ...(params.outputTokens != null ? { outputTokens: params.outputTokens } : {}),
    };
    rec.result = makeEvalResult({
      overall: params.overall!,
      gate: params.gate!,
      judgeMessage: params.judgeMessage,
      judgeFix: params.judgeFix,
    });
    const dir = `cells/${cellKey(cell)}/${params.taskId}/rep${params.rep}`;
    rec.artifacts = { dir, diffPatch: `${dir}/diff.patch`, transcript: `${dir}/transcript.jsonl` };
  } else if (params.status === 'agent-error' || params.status === 'timeout') {
    rec.agentMeta = { durationMs: params.durationMs ?? 300_000 };
  }
  return rec;
}

function makeManifest(runId: string, label: string, records: CellRecord[]): RunManifest {
  return {
    runId,
    label,
    profile: 'smoke',
    startedAt: '2026-08-20T09:00:00.000Z',
    finishedAt: '2026-08-20T09:24:00.000Z',
    nodeVersion: process.version,
    adapters: { 'claude-code': { version: '1.2.3' } },
    systems: {
      systemB: { root: '/fixtures/systemB', commit: 'abcdef1234567890', catalogSrcHash: 'hash1', tokensCssHash: 'hash2' },
      systemA: { root: '/fixtures/systemA', commit: '0987654321fedcba', catalogSrcHash: 'hash3', tokensCssHash: 'hash4' },
    },
    cells: records.map((r) => ({
      spec: { system: r.cell.system, context: r.cell.context, model: r.cell.model, agent: r.cell.agent, taskId: r.taskId, rep: r.rep },
      status: r.status,
      skipReason: r.skipReason,
    })),
    totalCostUsd: records.reduce((s, r) => s + (r.agentMeta?.costUsd ?? 0), 0),
    wallClockMs: 24 * 60 * 1000,
  };
}

function cloneResults<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Scenario A: 2 tasks x 3 cellKeys (systemB bare/agents-md/skill) x 2 reps,
// including one skipped rep and one agent-error rep — the shape the spec asks for.
// ---------------------------------------------------------------------------

const scenarioARecords: CellRecord[] = [
  makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-a', rep: 1, status: 'ok', overall: 80, gate: 'pass' }),
  makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-a', rep: 2, status: 'ok', overall: 90, gate: 'pass' }),

  makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-b', rep: 1, status: 'ok', overall: 70, gate: 'review' }),
  makeRecord({
    system: 'systemB',
    context: 'bare',
    model: 'sonnet',
    taskId: 'task-b',
    rep: 2,
    status: 'skipped',
    skipReason: 'task timed out waiting for workspace setup',
  }),

  makeRecord({ system: 'systemB', context: 'agents-md', model: 'sonnet', taskId: 'task-a', rep: 1, status: 'ok', overall: 88, gate: 'pass' }),
  makeRecord({ system: 'systemB', context: 'agents-md', model: 'sonnet', taskId: 'task-a', rep: 2, status: 'ok', overall: 92, gate: 'pass' }),

  makeRecord({
    system: 'systemB',
    context: 'agents-md',
    model: 'sonnet',
    taskId: 'task-b',
    rep: 1,
    status: 'ok',
    overall: 75,
    gate: 'review',
    judgeMessage: 'Uses Button with a manual onClick confirm instead of the confirm-dialog pattern.',
    judgeFix: 'Wrap the destructive action in <ConfirmDialog>.',
  }),
  makeRecord({ system: 'systemB', context: 'agents-md', model: 'sonnet', taskId: 'task-b', rep: 2, status: 'agent-error' }),

  makeRecord({ system: 'systemB', context: 'skill', model: 'sonnet', taskId: 'task-a', rep: 1, status: 'ok', overall: 95, gate: 'pass' }),
  makeRecord({ system: 'systemB', context: 'skill', model: 'sonnet', taskId: 'task-a', rep: 2, status: 'ok', overall: 95, gate: 'pass' }),

  makeRecord({ system: 'systemB', context: 'skill', model: 'sonnet', taskId: 'task-b', rep: 1, status: 'ok', overall: 60, gate: 'review' }),
  makeRecord({ system: 'systemB', context: 'skill', model: 'sonnet', taskId: 'task-b', rep: 2, status: 'ok', overall: 80, gate: 'review' }),
];

const scenarioAManifest = makeManifest('run-A', 'Scenario A', scenarioARecords);

test('buildRunResults: aggregates 10 ok records into 6 groups with known mean/std/gate', () => {
  const results = buildRunResults(scenarioAManifest, scenarioARecords);

  assert.equal(results.runId, 'run-A');
  assert.equal(results.records.length, 12);
  assert.equal(results.aggregates.length, 6);

  const byKey = new Map(results.aggregates.map((a) => [`${a.cellKey}::${a.taskId}`, a]));

  const bareA = byKey.get('systemB_bare_sonnet::task-a')!;
  assert.equal(bareA.n, 2);
  assert.equal(bareA.meanOverall, 85);
  assert.equal(bareA.stdOverall, 5);
  assert.equal(bareA.worstGate, 'pass');
  assert.equal(bareA.meanDimensions.imports, 85);
  assert.equal(bareA.meanDimensions.judgment, 85);

  const bareB = byKey.get('systemB_bare_sonnet::task-b')!;
  assert.equal(bareB.n, 1); // one rep skipped, excluded from the aggregate
  assert.equal(bareB.meanOverall, 70);
  assert.equal(bareB.stdOverall, 0);
  assert.equal(bareB.worstGate, 'review');

  const agentsMdA = byKey.get('systemB_agents-md_sonnet::task-a')!;
  assert.equal(agentsMdA.n, 2);
  assert.equal(agentsMdA.meanOverall, 90);
  assert.equal(agentsMdA.stdOverall, 2);
  assert.equal(agentsMdA.worstGate, 'pass');

  const agentsMdB = byKey.get('systemB_agents-md_sonnet::task-b')!;
  assert.equal(agentsMdB.n, 1); // one rep agent-errored, excluded from the aggregate
  assert.equal(agentsMdB.meanOverall, 75);
  assert.equal(agentsMdB.worstGate, 'review');

  const skillA = byKey.get('systemB_skill_sonnet::task-a')!;
  assert.equal(skillA.n, 2);
  assert.equal(skillA.meanOverall, 95);
  assert.equal(skillA.stdOverall, 0);

  const skillB = byKey.get('systemB_skill_sonnet::task-b')!;
  assert.equal(skillB.n, 2);
  assert.equal(skillB.meanOverall, 70);
  assert.equal(skillB.stdOverall, 10);
  assert.equal(skillB.worstGate, 'review');
});

test('buildRunResults: a cell with zero ok records is visible in records but has no aggregate', () => {
  const records: CellRecord[] = [
    makeRecord({
      system: 'systemB',
      context: 'bare',
      model: 'sonnet',
      taskId: 'task-c',
      rep: 1,
      status: 'skipped',
      skipReason: 'prerequisite catalog missing',
    }),
    makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-c', rep: 2, status: 'agent-error' }),
  ];
  const manifest = makeManifest('run-zero-ok', 'Zero-ok scenario', records);
  const results = buildRunResults(manifest, records);

  assert.equal(results.records.length, 2);
  assert.equal(results.aggregates.length, 0);
  assert.equal(
    results.aggregates.find((a) => a.taskId === 'task-c'),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// ci.ts
// ---------------------------------------------------------------------------

const ciOpts: CiOptions = { maxScoreDrop: 5, maxErroredCellRatio: 0.2, failOn: 'regression' };

test('ciCheck: identical baseline passes (exit 0, no regressions)', () => {
  const current = buildRunResults(scenarioAManifest, scenarioARecords);
  const baseline = buildRunResults(cloneResults(scenarioAManifest), cloneResults(scenarioARecords));

  const outcome = ciCheck(current, baseline, ciOpts);
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.regressions, []);
  assert.match(outcome.summary, /PASS/);
});

test('ciCheck: baseline doctored +10 points on one cell triggers a score regression (exit 1)', () => {
  const current = buildRunResults(scenarioAManifest, scenarioARecords);
  const baseline = cloneResults(current);
  const doctored = baseline.aggregates.find((a) => a.cellKey === 'systemB_bare_sonnet' && a.taskId === 'task-a')!;
  doctored.meanOverall += 10; // was 85 -> 95; drop of 10 exceeds maxScoreDrop of 5

  const outcome = ciCheck(current, baseline, ciOpts);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.regressions.length, 1);
  assert.match(outcome.regressions[0]!, /task-a/);
  assert.match(outcome.regressions[0]!, /systemB_bare_sonnet/);
  assert.match(outcome.summary, /REGRESSION/);
});

test('ciCheck: gate worsening (pass -> review) triggers exit 1 even with an unchanged score', () => {
  const current = buildRunResults(scenarioAManifest, scenarioARecords);
  const baseline = cloneResults(current);
  const worsened = baseline.aggregates.find((a) => a.cellKey === 'systemB_skill_sonnet' && a.taskId === 'task-b')!;
  // current worstGate for this cell is 'review'; pretend the baseline used to pass.
  worsened.worstGate = 'pass';

  const outcome = ciCheck(current, baseline, ciOpts);
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.regressions.length, 1);
  assert.match(outcome.regressions[0]!, /pass → review/);
});

test('ciCheck: most cells errored is inconclusive (exit 3), independent of baseline', () => {
  const records: CellRecord[] = [
    makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-x', rep: 1, status: 'ok', overall: 90, gate: 'pass' }),
    makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-x', rep: 2, status: 'agent-error' }),
    makeRecord({ system: 'systemB', context: 'agents-md', model: 'sonnet', taskId: 'task-x', rep: 1, status: 'agent-error' }),
    makeRecord({ system: 'systemB', context: 'agents-md', model: 'sonnet', taskId: 'task-x', rep: 2, status: 'timeout' }),
    makeRecord({ system: 'systemB', context: 'skill', model: 'sonnet', taskId: 'task-x', rep: 1, status: 'agent-error' }),
  ];
  const manifest = makeManifest('run-mostly-errored', 'Mostly errored', records);
  const current = buildRunResults(manifest, records);

  // 4 of 5 non-skipped cells errored/timed out -> 80%, well above the 20% ceiling.
  const outcome = ciCheck(current, null, ciOpts);
  assert.equal(outcome.exitCode, 3);
  assert.match(outcome.summary, /INCONCLUSIVE/);
});

test('ciCheck: failOn "fail" blocks on any aggregate at gate=fail, regardless of baseline', () => {
  const records: CellRecord[] = [
    makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-y', rep: 1, status: 'ok', overall: 20, gate: 'fail' }),
  ];
  const manifest = makeManifest('run-with-fail-gate', 'Has a fail gate', records);
  const current = buildRunResults(manifest, records);

  const outcome = ciCheck(current, null, { maxScoreDrop: 5, maxErroredCellRatio: 0.2, failOn: 'fail' });
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.regressions.length, 1);
  assert.match(outcome.regressions[0]!, /gate=fail/);
});

test('ciCheck: failOn "regression" with no baseline falls back to the fail-gate check and notes it', () => {
  const current = buildRunResults(scenarioAManifest, scenarioARecords); // no fail-gate cells
  const outcome = ciCheck(current, null, ciOpts);
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.summary, /no baseline was supplied/);
});

test('GATE_RANK orders pass < review < fail', () => {
  assert.ok(GATE_RANK.pass < GATE_RANK.review);
  assert.ok(GATE_RANK.review < GATE_RANK.fail);
});

// ---------------------------------------------------------------------------
// html.ts / compare.ts: self-contained-page assertions
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = ['<script src=', '<link ', 'fetch(', 'url(http'];

test('renderReportHtml: matrix shows score colour only, no gate chips or fail marks', () => {
  const results = buildRunResults(scenarioAManifest, scenarioARecords);
  const html = renderReportHtml(results);
  const table = html.match(/<table class="matrix">[\s\S]*?<\/table>/)?.[0] ?? '';

  assert.ok(!table.includes('chip-pass'), 'pass chips should not appear on the matrix');
  assert.ok(!table.includes('chip-review'), 'review chips should not appear on the matrix');
  assert.ok(!table.includes('chip-fail'), 'fail chips should not appear on the matrix');
  assert.ok(!table.includes('is-fail'));
  assert.ok(!table.includes('mx-fail'));
  // drill-down still names the gate
  assert.match(html, /chip-pass/);
  assert.match(html, /chip-review/);

  const failRecords: CellRecord[] = [
    makeRecord({
      system: 'systemB',
      context: 'bare',
      model: 'sonnet',
      taskId: 'task-fail',
      rep: 1,
      status: 'ok',
      overall: 20,
      gate: 'fail',
    }),
  ];
  const failHtml = renderReportHtml(
    buildRunResults(makeManifest('run-fail-mark', 'Fail mark', failRecords), failRecords),
  );
  const failTable = failHtml.match(/<table class="matrix">[\s\S]*?<\/table>/)?.[0] ?? '';
  assert.match(failTable, /mx-cell tone-red/);
  assert.ok(!failTable.includes('is-fail'));
  assert.ok(!failTable.includes('mx-fail'));
  assert.match(failTable, /aria-label="20\.0, n=1, fail"/);
});

test('renderReportHtml: surfaces input/output tokens in the header and per-rep cards', () => {
  const records: CellRecord[] = [
    makeRecord({
      system: 'systemB',
      context: 'bare',
      model: 'gateway:DeepSeek V4 Flash (Trusted)',
      taskId: 'task-a',
      rep: 1,
      status: 'ok',
      overall: 80,
      gate: 'pass',
      inputTokens: 8100,
      outputTokens: 1200,
      costUsd: 0.0044,
    }),
  ];
  const html = renderReportHtml(buildRunResults(makeManifest('run-tokens', 'Token run', records), records));
  assert.match(html, /Total tokens/);
  assert.match(html, /8\.1k in · 1\.2k out/);
  assert.match(html, /\$0\.0044/);
  assert.ok(!html.includes('Adapters'), 'report header should not list adapters');
});

test('renderReportHtml: reports no dollar figure when a record cannot be priced', () => {
  const rec = makeRecord({
    system: 'systemB',
    context: 'bare',
    model: 'gateway:GPT 5.6 Luna EU (Trusted)',
    taskId: 'task-a',
    rep: 1,
    status: 'ok',
    overall: 80,
    gate: 'pass',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    costUsd: undefined,
  });
  delete rec.agentMeta!.costUsd;
  const html = renderReportHtml(buildRunResults(makeManifest('run-cost-fill', 'Cost fill', [rec]), [rec]));
  assert.match(html, /Total cost/);
  // No pricing catalog ships, so an unpriced record must read as n/a rather
  // than inventing a rate. Token counts are still reported.
  assert.match(html, /n\/a/);
  assert.ok(!html.includes('Adapters'));
});

test('renderReportHtml: fully self-contained, no external requests', () => {
  const results = buildRunResults(scenarioAManifest, scenarioARecords);
  const html = renderReportHtml(results);

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /Scenario A/);
  assert.match(html, /systemB/);
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.ok(!html.includes(pattern), `report html should not contain ${JSON.stringify(pattern)}`);
  }
  // the drilldown detail must still be present, just hidden until toggled
  assert.match(html, /confirm-dialog pattern/);
  assert.match(html, /diff\.patch/);
  // single-system run: one table, titled with that system
  assert.equal((html.match(/<table class="matrix">/g) ?? []).length, 1);
  assert.match(html, /<h3>systemB<\/h3>/);
});

test('renderReportHtml: splits the matrix into one table per system', () => {
  const records: CellRecord[] = [
    makeRecord({ system: 'systemA', context: 'bare', model: 'sonnet', taskId: 'task-a', rep: 1, status: 'ok', overall: 80, gate: 'pass' }),
    makeRecord({ system: 'systemA', context: 'skill', model: 'sonnet', taskId: 'task-a', rep: 1, status: 'ok', overall: 90, gate: 'pass' }),
    makeRecord({ system: 'systemB', context: 'bare', model: 'sonnet', taskId: 'task-a', rep: 1, status: 'ok', overall: 70, gate: 'review' }),
    makeRecord({ system: 'systemB', context: 'skill', model: 'sonnet', taskId: 'task-a', rep: 1, status: 'ok', overall: 88, gate: 'pass' }),
  ];
  const html = renderReportHtml(buildRunResults(makeManifest('run-split', 'Split systems', records), records));

  assert.equal((html.match(/<table class="matrix">/g) ?? []).length, 2);
  assert.match(html, /<h3>systemA<\/h3>/);
  assert.match(html, /<h3>systemB<\/h3>/);
  assert.ok(!html.includes('class="system-group"'), 'system name is the table title, not a spanning header row');
  // systemA table comes first (alphabetical), and its drilldowns stay with that table
  const systemAAt = html.indexOf('<h3>systemA</h3>');
  const systemBAt = html.indexOf('<h3>systemB</h3>');
  const systemADrill = html.indexOf('drill_task-a__systemA_bare_sonnet');
  const systemBDrill = html.indexOf('drill_task-a__systemB_bare_sonnet');
  assert.ok(systemAAt < systemADrill && systemADrill < systemBAt);
  assert.ok(systemBAt < systemBDrill);
});

test('renderCompareHtml: fully self-contained, shows deltas vs the first run', () => {
  const runA = buildRunResults(scenarioAManifest, scenarioARecords);

  const recordsB = scenarioARecords.map((r) =>
    r.result ? { ...r, result: { ...r.result, overall: r.result.overall - 15 } } : r,
  );
  const manifestB = makeManifest('run-B', 'Scenario B (regressed)', recordsB);
  const runB = buildRunResults(manifestB, recordsB);

  const html = renderCompareHtml([runA, runB]);

  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /Run comparison/);
  assert.match(html, /Scenario A/);
  assert.match(html, /Scenario B \(regressed\)/);
  assert.match(html, /delta-down/); // runB is strictly worse on every shared cell
  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.ok(!html.includes(pattern), `compare html should not contain ${JSON.stringify(pattern)}`);
  }
});

// ---------------------------------------------------------------------------
// Demo fixtures: a richer, multi-system run written to disk for manual review.
// ---------------------------------------------------------------------------

function buildDemoRun(runId: string, label: string, scoreShift: number): { manifest: RunManifest; records: CellRecord[] } {
  const systems: SystemId[] = ['systemB', 'systemA'];
  const contexts: ContextLevel[] = ['bare', 'agents-md', 'skill'];
  const tasks = ['confirm-account-deletion', 'inline-edit-field', 'empty-state-cta'];
  const contextBase: Record<ContextLevel, number> = { bare: 58, 'agents-md': 76, skill: 91, mcp: 0 };
  const systemAdjust: Record<SystemId, number> = { systemB: 0, systemA: -6 };
  const taskAdjust: Record<string, number> = {
    'confirm-account-deletion': 0,
    'inline-edit-field': -8,
    'empty-state-cta': 4,
  };
  const repJitter = [3, -3];

  const gateFor = (score: number): Gate => (score >= 85 ? 'pass' : score >= 60 ? 'review' : 'fail');
  const clamp = (n: number) => Math.max(0, Math.min(100, n));

  const records: CellRecord[] = [];

  for (const system of systems) {
    for (const context of contexts) {
      for (const taskId of tasks) {
        // systemA has no shipped skill bundle for this task yet — the cell was never run.
        if (system === 'systemA' && context === 'skill' && taskId === 'confirm-account-deletion') continue;

        // systemA's bare context can't run inline-edit-field: workspace setup fails every time.
        if (system === 'systemA' && context === 'bare' && taskId === 'inline-edit-field') {
          records.push(
            makeRecord({ system, context, model: 'sonnet', taskId, rep: 1, status: 'skipped', skipReason: 'systemA workspace bootstrap failed: missing vibe catalog fixture' }),
            makeRecord({ system, context, model: 'sonnet', taskId, rep: 2, status: 'skipped', skipReason: 'systemA workspace bootstrap failed: missing vibe catalog fixture' }),
          );
          continue;
        }

        for (let repIdx = 0; repIdx < 2; repIdx++) {
          const rep = repIdx + 1;

          // systemB/bare/empty-state-cta rep2 crashes mid-generation.
          if (system === 'systemB' && context === 'bare' && taskId === 'empty-state-cta' && rep === 2) {
            records.push(makeRecord({ system, context, model: 'sonnet', taskId, rep, status: 'agent-error', durationMs: 280_000 }));
            continue;
          }

          const raw = contextBase[context] + systemAdjust[system] + (taskAdjust[taskId] ?? 0) + repJitter[repIdx]! + scoreShift;
          let overall = clamp(raw);
          let gate = gateFor(overall);
          let judgeMessage: string | undefined;
          let judgeFix: string | undefined;

          // systemB/skill/confirm-account-deletion rep1 hallucinates a component — force a fail.
          if (system === 'systemB' && context === 'skill' && taskId === 'confirm-account-deletion' && rep === 1) {
            overall = clamp(overall - 40);
            gate = 'fail';
            judgeMessage = 'Imports <DestructiveModal> from @acme-ui/components, which does not exist in the catalog.';
            judgeFix = 'Use <Dialog variant="destructive"> with a <Button variant="destructive"> action instead.';
          } else if (gate === 'review') {
            judgeMessage = 'Copy reads as generic ("Are you sure?") rather than naming the destructive action.';
            judgeFix = 'State what will be lost, e.g. "Delete 3 saved drafts?"';
          }

          records.push(
            makeRecord({
              system,
              context,
              model: 'sonnet',
              taskId,
              rep,
              status: 'ok',
              overall,
              gate,
              judgeMessage,
              judgeFix,
              durationMs: 45_000 + repIdx * 9_000,
              costUsd: 0.08 + repIdx * 0.01,
            }),
          );
        }
      }
    }
  }

  return { manifest: makeManifest(runId, label, records), records };
}

test('writes demo-report.html and demo-compare.html for manual review', () => {
  const demoA = buildDemoRun('run-2026-08-24-full', 'the example system context ablation — full profile', 0);
  const demoB = buildDemoRun('run-2026-08-17-full', 'the example system context ablation — prior week', -6);

  const runA = buildRunResults(demoA.manifest, demoA.records);
  const runB = buildRunResults(demoB.manifest, demoB.records);

  const reportHtml = renderReportHtml(runA);
  const compareHtml = renderCompareHtml([runA, runB]);

  for (const pattern of FORBIDDEN_PATTERNS) {
    assert.ok(!reportHtml.includes(pattern));
    assert.ok(!compareHtml.includes(pattern));
  }

  const dir = mkdtempSync(join(tmpdir(), 'odsys-report-'));
  const reportPath = join(dir, 'demo-report.html');
  const comparePath = join(dir, 'demo-compare.html');
  writeFileSync(reportPath, reportHtml, 'utf8');
  writeFileSync(comparePath, compareHtml, 'utf8');
  console.log(`demo report: ${reportPath}`);
  console.log(`demo compare: ${comparePath}`);
});
