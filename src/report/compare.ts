// Side-by-side run comparison: same self-contained-page style as html.ts, but
// the unit of comparison is a (taskId × cellKey) pair shown across N runs, with
// deltas taken against the first run in the list (the implicit baseline for
// the view — not to be confused with ci.ts's baseline, which is caller-chosen).

import { recordCostUsd } from '../providers/pricing.ts';
import type { Gate, RunResults } from '../types.ts';
import { judgeSetup } from './aggregate.ts';
import { esc, fmtScore, fmtUsd, fmtTokenPair, jsonScript, page } from './shared.ts';

interface Combo {
  taskId: string;
  cellKey: string;
}

function comboKey(taskId: string, ck: string): string {
  return `${taskId}::${ck}`;
}

/** Only combos present in more than one run are comparable. */
function collectComparableCombos(runs: RunResults[]): Combo[] {
  const presence = new Map<string, Set<number>>();
  const combos = new Map<string, Combo>();

  runs.forEach((run, i) => {
    for (const a of run.aggregates) {
      const key = comboKey(a.taskId, a.cellKey);
      combos.set(key, { taskId: a.taskId, cellKey: a.cellKey });
      const set = presence.get(key) ?? new Set<number>();
      set.add(i);
      presence.set(key, set);
    }
  });

  return [...combos.entries()]
    .filter(([key]) => (presence.get(key)?.size ?? 0) >= 2)
    .map(([, combo]) => combo)
    .sort((a, b) => {
      if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
      return a.cellKey < b.cellKey ? -1 : a.cellKey > b.cellKey ? 1 : 0;
    });
}

function deltaClass(delta: number): string {
  if (Math.abs(delta) < 0.05) return 'delta-flat';
  return delta > 0 ? 'delta-up' : 'delta-down';
}

function fmtDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}`;
}

function renderComboRow(combo: Combo, runs: RunResults[]): string {
  const aggs = runs.map((run) => run.aggregates.find((a) => a.taskId === combo.taskId && a.cellKey === combo.cellKey));
  const baseline = aggs[0];

  const cells = aggs
    .map((a, i) => {
      const scoreCell = `<td class="num">${a ? fmtScore(a.meanOverall) : 'n/a'}</td>`;
      if (i === 0) return scoreCell;
      if (!a || !baseline) return `${scoreCell}<td class="num">n/a</td>`;
      const delta = a.meanOverall - baseline.meanOverall;
      return `${scoreCell}<td class="num ${deltaClass(delta)}">${fmtDelta(delta)}</td>`;
    })
    .join('');

  return `<tr><td class="task-name">${esc(combo.taskId)}</td><td class="mono">${esc(combo.cellKey)}</td>${cells}</tr>`;
}

function renderComparisonTable(runs: RunResults[]): string {
  const combos = collectComparableCombos(runs);
  if (combos.length === 0) {
    return `<p class="na">No (task &times; cellKey) combination is present in more than one run.</p>`;
  }

  const baselineLabel = esc(runs[0]!.manifest.label ?? runs[0]!.runId);
  const headerCells = runs
    .map((run, i) => {
      const label = esc(run.manifest.label ?? run.runId);
      return i === 0 ? `<th>${label}</th>` : `<th>${label}</th><th>&Delta; vs ${baselineLabel}</th>`;
    })
    .join('');

  const rows = combos.map((c) => renderComboRow(c, runs)).join('');

  return `<div class="scroll-x"><table class="matrix">
    <thead><tr><th class="task-name">task</th><th>cell</th>${headerCells}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

interface RunSummary {
  label: string;
  overallMean: number | null;
  gateCounts: Record<Gate, number>;
  totalCost: number | null;
  tokenPair: string | null;
  judge: string;
}

function summarizeRun(run: RunResults): RunSummary {
  const overalls = run.aggregates.map((a) => a.meanOverall);
  const overallMean = overalls.length ? overalls.reduce((a, b) => a + b, 0) / overalls.length : null;
  const gateCounts: Record<Gate, number> = { pass: 0, review: 0, fail: 0 };
  for (const a of run.aggregates) gateCounts[a.worstGate] += 1;
  const costs = run.records.map(recordCostUsd).filter((v): v is number => v != null);
  const totalCost = costs.length ? costs.reduce((s, v) => s + v, 0) : null;
  const inputs = run.records.map((r) => r.agentMeta?.inputTokens).filter((v): v is number => v != null);
  const outputs = run.records.map((r) => r.agentMeta?.outputTokens).filter((v): v is number => v != null);
  const tokenPair = fmtTokenPair(
    inputs.length ? inputs.reduce((s, v) => s + v, 0) : null,
    outputs.length ? outputs.reduce((s, v) => s + v, 0) : null,
  );
  const j = judgeSetup(run.records);
  const judge = `${j.label}, ${j.judged} of ${j.ok} cells`;
  return { label: run.manifest.label ?? run.runId, overallMean, gateCounts, totalCost, tokenPair, judge };
}

function renderSummary(runs: RunResults[]): string {
  const summaries = runs.map(summarizeRun);
  return `<div class="meta-grid">${summaries
    .map(
      (s) => `<div class="meta-item">
      <div class="label">${esc(s.label)}</div>
      <div class="value">${s.overallMean != null ? fmtScore(s.overallMean) : 'n/a'} overall</div>
      <div class="sub">${s.gateCounts.pass} pass &middot; ${s.gateCounts.review} review &middot; ${s.gateCounts.fail} fail</div>
      <div class="sub">${fmtUsd(s.totalCost)}${s.tokenPair ? ` &middot; ${s.tokenPair}` : ''}</div>
      <div class="sub">judge ${esc(s.judge)}</div>
    </div>`,
    )
    .join('')}</div>`;
}

/**
 * Judgment carries most of the agentic variance, so two runs judged with a
 * different model or sample count are not comparable on that dimension.
 * One line per run that differs from the first, plus one per run with
 * cells still missing a verdict.
 */
export function judgeMismatchWarnings(runs: RunResults[]): string[] {
  const setups = runs.map((r) => ({ name: r.manifest.label ?? r.runId, ...judgeSetup(r.records) }));
  const out: string[] = [];
  const first = setups[0]!;
  for (const s of setups.slice(1)) {
    if (s.label !== first.label) {
      out.push(`judged differently: ${first.name} (${first.label}) vs ${s.name} (${s.label}); judgment deltas mix judge variance into the comparison`);
    }
  }
  for (const s of setups) {
    if (s.missing) out.push(`${s.name}: ${s.missing} of ${s.ok} ok cells have no judge verdict (fill with judge --run <dir> --missing)`);
  }
  return out;
}

export function renderCompareHtml(runs: RunResults[]): string {
  const warnings = judgeMismatchWarnings(runs);
  const runLabels = runs.map((r) => esc(r.manifest.label ?? r.runId)).join(' vs ');

  const body = `<main class="wrap">
  <header class="top">
    <h1>Run comparison</h1>
    <p class="lede">${runs.length} run(s): ${runLabels}. Deltas are against the first run listed.</p>
    ${warnings.length ? `<div class="judge-note"><b>Not like for like</b><ul style="margin:6px 0 0;padding-left:18px">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
  </header>

  <section>
    <h2>Summary</h2>
    ${renderSummary(runs)}
  </section>

  <section>
    <h2>Per (task &times; cellKey) comparison</h2>
    <p class="lede">Only combinations present in more than one run are listed &mdash; a combo unique to
      one run has nothing to compare against.</p>
    ${renderComparisonTable(runs)}
  </section>

  <footer class="foot">Generated by <code>open-design-system-bench</code>.</footer>
</main>
${jsonScript('compare-data', runs)}`;

  return page(`open-design-system-bench · compare (${runs.length} runs)`, body, '');
}
