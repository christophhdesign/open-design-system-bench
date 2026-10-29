// CI gate: turns a RunResults (+ optional baseline) into a pass/fail/inconclusive
// verdict for scripts/CI to act on. Three independent checks, evaluated in order:
//
//   1. Inconclusive  — always checked. Too many agent-error/timeout cells, a
//      paused or empty run, or (against a baseline) too little measured
//      overlap means the run cannot support a verdict, regardless of scores.
//      Exit 3.
//   2. Fail gate      — checked when failOn === 'fail' (an absolute quality bar):
//      any aggregate at gate 'fail' blocks the build. Exit 1.
//   3. Regression     — checked when failOn === 'regression' (a relative bar):
//      a matching (cellKey × taskId) aggregate that dropped more than
//      maxScoreDrop points, or whose gate got worse, blocks the build. Exit 1.
//      Only measured cells are compared: one with a result, and with a judge
//      verdict wherever the baseline cell was judged (a mechanical-only score
//      runs high). Coverage is reported as matched, unmeasured and new.
//      With failOn === 'regression' but no baseline, the regression check can't
//      run at all, so it falls back to the fail-gate check instead — that's the
//      "only inconclusive/fail checks apply" case from the spec.

import type { CellRecord, Gate, RunResults } from '../types.ts';
import { cellKey } from '../types.ts';
import { GATE_RANK, isJudgeMissing } from './aggregate.ts';

export interface CiOptions {
  maxScoreDrop: number;
  maxErroredCellRatio: number;
  failOn: 'regression' | 'fail';
  /** Least share of comparable cells that must be measured for a regression verdict. Default 0.8. */
  minCoverage?: number;
}

export interface CiCoverage {
  /** Cells this run planned that the baseline also has. */
  comparable: number;
  /** Comparable cells with a result and, where the baseline was judged, a verdict. */
  matched: number;
  /** Comparable cells without one: errored, timed out, or missing a verdict. */
  unmeasured: string[];
  /** Cells this run has that the baseline does not. Never a regression, never against coverage. */
  added: number;
}

export interface CiOutcome {
  exitCode: 0 | 1 | 3;
  summary: string;
  regressions: string[];
  coverage?: CiCoverage;
}

const DEFAULT_MIN_COVERAGE = 0.8;
const recKey = (r: CellRecord) => `${cellKey(r.cell)}::${r.taskId}`;

/**
 * Which of this run's planned cells can be compared with the baseline. A key
 * is measured when it has an aggregate and both sides were scored on the same
 * basis: judged on both, or on neither. A mechanical-only score runs high, so
 * a judged cell against an unjudged one (either way round) is not a comparison.
 */
export function ciCoverage(current: RunResults, baseline: RunResults): { coverage: CiCoverage; measured: Set<string> } {
  const baseKeys = new Set(baseline.aggregates.map((a) => `${a.cellKey}::${a.taskId}`));
  const judgedKeys = (run: RunResults) => {
    const missing = new Set(run.records.filter(isJudgeMissing).map(recKey));
    return new Set(run.records.filter((r) => r.status === 'ok' && r.result && !missing.has(recKey(r))).map(recKey));
  };
  const baseJudged = judgedKeys(baseline);
  const curJudged = judgedKeys(current);
  const planned = new Set(current.records.filter((r) => r.status !== 'skipped').map(recKey));
  const aggregated = new Set(current.aggregates.map((a) => `${a.cellKey}::${a.taskId}`));
  const measured = new Set<string>();
  const unmeasured: string[] = [];
  let added = 0;
  for (const key of planned) {
    if (!baseKeys.has(key)) {
      added += 1;
      continue;
    }
    if (aggregated.has(key) && baseJudged.has(key) === curJudged.has(key)) measured.add(key);
    else unmeasured.push(key);
  }
  return { coverage: { comparable: measured.size + unmeasured.length, matched: measured.size, unmeasured, added }, measured };
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

function regressionMessages(current: RunResults, baseline: RunResults, maxScoreDrop: number, measured: Set<string>): string[] {
  const baselineByKey = new Map(baseline.aggregates.map((a) => [`${a.cellKey}::${a.taskId}`, a]));
  const messages: string[] = [];

  for (const cur of current.aggregates) {
    if (!measured.has(`${cur.cellKey}::${cur.taskId}`)) continue; // new, or not measured: reported as coverage
    const base = baselineByKey.get(`${cur.cellKey}::${cur.taskId}`)!;

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
  if (current.manifest.paused) {
    lines.push('INCONCLUSIVE: the run is paused with cells still pending; resume it before gating on it.');
    return { exitCode: 3, summary: lines.join('\n'), regressions: [] };
  }
  if (nonSkipped === 0) {
    lines.push('INCONCLUSIVE: no cell in this run produced anything to judge.');
    return { exitCode: 3, summary: lines.join('\n'), regressions: [] };
  }

  // Informational context regardless of failOn, so the summary is legible either way.
  const counts = gateCounts(current);
  lines.push(`Gate counts: ${counts.pass} pass · ${counts.review} review · ${counts.fail} fail`);

  const failMsgs = failGateMessages(current);
  const cov = baseline ? ciCoverage(current, baseline) : undefined;
  if (cov) {
    const { comparable, matched, unmeasured, added } = cov.coverage;
    const minCoverage = opts.minCoverage ?? DEFAULT_MIN_COVERAGE;
    lines.push(
      `Coverage vs baseline: ${matched} of ${comparable} comparable cell(s) measured` +
        `${comparable ? ` (${((matched / comparable) * 100).toFixed(0)}%, min ${(minCoverage * 100).toFixed(0)}%)` : ''}` +
        `, ${unmeasured.length} unmeasured, ${added} new without a baseline`,
    );
    if (unmeasured.length) lines.push(...unmeasured.slice(0, 20).map((k) => `  - unmeasured: ${k}`));
    if (opts.failOn === 'regression' && (comparable === 0 || matched / comparable < minCoverage)) {
      lines.push(
        comparable === 0
          ? 'INCONCLUSIVE: no cell in this run overlaps the baseline, so there is nothing to compare.'
          : 'INCONCLUSIVE: too few comparable cells were measured to call this a regression check.',
      );
      return { exitCode: 3, summary: lines.join('\n'), regressions: [], coverage: cov.coverage };
    }
  }
  const baselineRegressions = baseline && cov ? regressionMessages(current, baseline, opts.maxScoreDrop, cov.measured) : [];
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
    return { exitCode: 1, summary: lines.join('\n'), regressions: baselineRegressions, coverage: cov?.coverage };
  }

  lines.push('PASS: no regressions vs baseline.');
  return { exitCode: 0, summary: lines.join('\n'), regressions: [], coverage: cov?.coverage };
}
