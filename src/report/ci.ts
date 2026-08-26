// CI gate: turns a RunResults (+ optional baseline) into a pass/fail/inconclusive
// verdict for scripts/CI to act on. Three independent checks, evaluated in order:
//
//   1. Inconclusive  — always checked. Too many agent-error/timeout cells means
//      the run itself is untrustworthy, regardless of scores. Exit 3.
//   2. Fail gate      — checked when failOn === 'fail' (an absolute quality bar):
//      any aggregate at gate 'fail' blocks the build. Exit 1.
//   3. Regression     — checked when failOn === 'regression' (a relative bar):
//      a matching (cellKey × taskId) aggregate that dropped more than
//      maxScoreDrop points, or whose gate got worse, blocks the build. Exit 1.
//      With failOn === 'regression' but no baseline, the regression check can't
//      run at all, so it falls back to the fail-gate check instead — that's the
//      "only inconclusive/fail checks apply" case from the spec.

import type { Gate, RunResults } from '../types.ts';
import { GATE_RANK } from './aggregate.ts';

export interface CiOptions {
  maxScoreDrop: number;
  maxErroredCellRatio: number;
  failOn: 'regression' | 'fail';
}

export interface CiOutcome {
  exitCode: 0 | 1 | 3;
  summary: string;
  regressions: string[];
}

function erroredCellRatio(current: RunResults): { ratio: number; errored: number; nonSkipped: number } {
  const nonSkipped = current.records.filter((r) => r.status !== 'skipped');
  const errored = nonSkipped.filter((r) => r.status === 'agent-error' || r.status === 'timeout');
  const ratio = nonSkipped.length > 0 ? errored.length / nonSkipped.length : 0;
  return { ratio, errored: errored.length, nonSkipped: nonSkipped.length };
}

function failGateMessages(current: RunResults): string[] {
  return current.aggregates
    .filter((a) => a.worstGate === 'fail')
    .map((a) => `${a.taskId} × ${a.cellKey}: gate=fail (meanOverall=${a.meanOverall.toFixed(1)}, n=${a.n})`);
}

function regressionMessages(current: RunResults, baseline: RunResults, maxScoreDrop: number): string[] {
  const baselineByKey = new Map(baseline.aggregates.map((a) => [`${a.cellKey}::${a.taskId}`, a]));
  const messages: string[] = [];

  for (const cur of current.aggregates) {
    const base = baselineByKey.get(`${cur.cellKey}::${cur.taskId}`);
    if (!base) continue; // nothing to compare against — new cell/task, not a regression

    const drop = base.meanOverall - cur.meanOverall;
    const scoreDropped = drop > maxScoreDrop;
    const gateWorsened = GATE_RANK[cur.worstGate] > GATE_RANK[base.worstGate];
    if (!scoreDropped && !gateWorsened) continue;

    const parts: string[] = [];
    if (scoreDropped) {
      parts.push(
        `score ${base.meanOverall.toFixed(1)} → ${cur.meanOverall.toFixed(1)} (Δ-${drop.toFixed(1)}, max drop ${maxScoreDrop})`,
      );
    }
    if (gateWorsened) {
      parts.push(`gate ${base.worstGate} → ${cur.worstGate}`);
    }
    messages.push(`${cur.taskId} × ${cur.cellKey}: ${parts.join('; ')}`);
  }

  return messages;
}

function gateCounts(current: RunResults): Record<Gate, number> {
  const counts: Record<Gate, number> = { pass: 0, review: 0, fail: 0 };
  for (const a of current.aggregates) counts[a.worstGate] += 1;
  return counts;
}

export function ciCheck(current: RunResults, baseline: RunResults | null, opts: CiOptions): CiOutcome {
  const lines: string[] = [];
  lines.push(`Run: ${current.manifest.label ?? current.runId} (${current.runId})`);

  // --- 1. inconclusive: data quality gate, always checked ---
  const { ratio, errored, nonSkipped } = erroredCellRatio(current);
  lines.push(
    `Errored/timeout ratio: ${(ratio * 100).toFixed(1)}% (${errored}/${nonSkipped} non-skipped cells, max ${(opts.maxErroredCellRatio * 100).toFixed(1)}%)`,
  );
  if (ratio > opts.maxErroredCellRatio) {
    lines.push('INCONCLUSIVE: too many errored/timeout cells to trust this run\'s scores.');
    return { exitCode: 3, summary: lines.join('\n'), regressions: [] };
  }

  // Informational context regardless of failOn, so the summary is legible either way.
  const counts = gateCounts(current);
  lines.push(`Gate counts: ${counts.pass} pass · ${counts.review} review · ${counts.fail} fail`);

  const failMsgs = failGateMessages(current);
  const baselineRegressions = baseline ? regressionMessages(current, baseline, opts.maxScoreDrop) : [];
  if (baseline) {
    lines.push(
      `Regressions vs baseline (${baseline.manifest.label ?? baseline.runId}): ${baselineRegressions.length}`,
    );
  } else {
    lines.push('No baseline supplied.');
  }

  // --- 2 & 3. failOn-selected gate ---
  if (opts.failOn === 'fail') {
    if (failMsgs.length > 0) {
      lines.push(`FAIL: ${failMsgs.length} cell(s) at gate=fail`);
      lines.push(...failMsgs.map((m) => `  - ${m}`));
      return { exitCode: 1, summary: lines.join('\n'), regressions: failMsgs };
    }
    lines.push('PASS: no cells at gate=fail.');
    return { exitCode: 0, summary: lines.join('\n'), regressions: [] };
  }

  // opts.failOn === 'regression'
  if (!baseline) {
    lines.push('failOn=regression requested but no baseline was supplied — regression check skipped;' +
      ' only the inconclusive and fail-gate checks apply.');
    if (failMsgs.length > 0) {
      lines.push(`FAIL: ${failMsgs.length} cell(s) at gate=fail`);
      lines.push(...failMsgs.map((m) => `  - ${m}`));
      return { exitCode: 1, summary: lines.join('\n'), regressions: failMsgs };
    }
    lines.push('PASS: no baseline to compare, no cells at gate=fail.');
    return { exitCode: 0, summary: lines.join('\n'), regressions: [] };
  }

  if (baselineRegressions.length > 0) {
    lines.push(`REGRESSION: ${baselineRegressions.length} cell(s) regressed vs baseline`);
    lines.push(...baselineRegressions.map((m) => `  - ${m}`));
    return { exitCode: 1, summary: lines.join('\n'), regressions: baselineRegressions };
  }

  lines.push('PASS: no regressions vs baseline.');
  return { exitCode: 0, summary: lines.join('\n'), regressions: [] };
}
