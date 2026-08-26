// Per-run HTML report: a single self-contained page (inline CSS/JS/data, zero
// network requests) mirroring the house style set by
// motion-perf-gate/src/report-html.mjs. Headline surface is one heatmap
// table per system — tasks × (context × model) — with a column summary row that is
// the actual benchmark comparison (context levels side by side), and a
// click-to-expand per-cell drilldown with per-rep scores, diffs, judge
// reasoning and artifact links.

import type { CellRecord, ContextLevel, SystemId, RunResults } from '../types.ts';
import { cellKey } from '../types.ts';
import { recordCostUsd } from '../providers/pricing.ts';
import {
  contextRank,
  esc,
  fmtDate,
  fmtMs,
  fmtScore,
  fmtUsd,
  fmtTokenPair,
  fmtTokens,
  gateChip,
  jsonScript,
  page,
  scoreTone,
  statusChip,
  summarizeNonOk,
} from './shared.ts';

interface ColumnInfo {
  cellKey: string;
  system: SystemId;
  context: ContextLevel;
  model: string;
}

type Aggregate = RunResults['aggregates'][number];

function collectColumns(results: RunResults): ColumnInfo[] {
  const map = new Map<string, ColumnInfo>();
  for (const rec of results.records) {
    const ck = cellKey(rec.cell);
    if (!map.has(ck)) {
      map.set(ck, { cellKey: ck, system: rec.cell.system, context: rec.cell.context, model: rec.cell.model });
    }
  }
  for (const c of results.manifest.cells) {
    const ck = cellKey(c.spec);
    if (!map.has(ck)) {
      map.set(ck, { cellKey: ck, system: c.spec.system, context: c.spec.context, model: c.spec.model });
    }
  }
  const cols = [...map.values()];
  cols.sort((a, b) => {
    if (a.system !== b.system) return a.system < b.system ? -1 : 1;
    const cr = contextRank(a.context) - contextRank(b.context);
    if (cr !== 0) return cr;
    return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
  });
  return cols;
}

function collectTaskIds(results: RunResults): string[] {
  const set = new Set<string>();
  for (const rec of results.records) set.add(rec.taskId);
  for (const c of results.manifest.cells) set.add(c.spec.taskId);
  return [...set].sort();
}

function groupColumnsBySystem(columns: ColumnInfo[]): Array<{ system: SystemId; columns: ColumnInfo[] }> {
  const groups: Array<{ system: SystemId; columns: ColumnInfo[] }> = [];
  for (const c of columns) {
    const last = groups[groups.length - 1];
    if (last && last.system === c.system) last.columns.push(c);
    else groups.push({ system: c.system, columns: [c] });
  }
  return groups;
}

function domId(taskId: string, ck: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `drill_${safe(taskId)}__${safe(ck)}`;
}

function renderHeader(results: RunResults): string {
  const m = results.manifest;
  const costs = results.records.map(recordCostUsd).filter((v): v is number => v != null);
  const totalCost = costs.length ? costs.reduce((s, v) => s + v, 0) : null;
  const inputs = results.records.map((r) => r.agentMeta?.inputTokens).filter((v): v is number => v != null);
  const outputs = results.records.map((r) => r.agentMeta?.outputTokens).filter((v): v is number => v != null);
  const totalIn = inputs.length ? inputs.reduce((s, v) => s + v, 0) : null;
  const totalOut = outputs.length ? outputs.reduce((s, v) => s + v, 0) : null;
  const tokenPair = fmtTokenPair(totalIn, totalOut);
  const systemCommits =
    (Object.keys(m.systems) as SystemId[])
      .map((system) => {
        const info = m.systems[system];
        return info ? `${system} @ ${info.commit.slice(0, 10)}` : null;
      })
      .filter((s): s is string => s != null)
      .join(', ') || 'n/a';

  const tokensItem = tokenPair
    ? `<div class="meta-item"><div class="label">Total tokens</div><div class="value">${fmtTokens((totalIn ?? 0) + (totalOut ?? 0))}</div><div class="sub">${tokenPair}</div></div>`
    : '';

  return `<header class="top">
    <h1>${esc(m.label ?? m.runId)}</h1>
    <div class="meta-grid">
      <div class="meta-item"><div class="label">Run</div><div class="value">${esc(m.runId)}</div><div class="sub">profile: ${esc(m.profile)}</div></div>
      <div class="meta-item"><div class="label">Window</div><div class="value">${fmtDate(m.startedAt)}</div><div class="sub">&rarr; ${fmtDate(m.finishedAt)}</div></div>
      <div class="meta-item"><div class="label">Wall clock</div><div class="value">${fmtMs(m.wallClockMs)}</div></div>
      <div class="meta-item"><div class="label">Total cost</div><div class="value">${fmtUsd(totalCost)}</div></div>
      ${tokensItem}
      <div class="meta-item"><div class="label">System commits</div><div class="value" style="font-size:12.5px">${esc(systemCommits)}</div></div>
    </div>
  </header>`;
}

function renderMatrixCell(
  taskId: string,
  col: ColumnInfo,
  agg: Aggregate | undefined,
  recs: CellRecord[] | undefined,
): string {
  const id = domId(taskId, col.cellKey);
  if (agg) {
    const tone = scoreTone(agg.meanOverall);
    const title = `n=${agg.n} · std=${agg.stdOverall.toFixed(1)} · gate=${agg.worstGate}`;
    const label = `${fmtScore(agg.meanOverall)}, n=${agg.n}${agg.worstGate === 'fail' ? ', fail' : ''}`;
    return `<td><button type="button" class="mx-cell tone-${tone}" title="${esc(title)}" aria-label="${esc(label)}" onclick="toggleDrill('${id}')">
      <span class="mx-score">${fmtScore(agg.meanOverall)}</span>
      <span class="mx-n">n=${agg.n}</span>
    </button></td>`;
  }
  if (recs && recs.length > 0) {
    const reason = summarizeNonOk(recs) || 'no successful reps';
    return `<td><button type="button" class="mx-cell tone-gray" title="${esc(reason)}" onclick="toggleDrill('${id}')">
      <span class="mx-score">n/a</span>
      <span class="chip chip-skip">no data</span>
    </button></td>`;
  }
  return `<td><span class="mx-cell tone-gray" title="not run" style="cursor:default">
    <span class="mx-score">n/a</span>
    <span class="chip chip-skip">n/a</span>
  </span></td>`;
}

function renderRepCard(rec: CellRecord): string {
  const scoreBit = rec.result
    ? `${gateChip(rec.result.gate)} <span class="mono">${fmtScore(rec.result.overall)}</span>`
    : '';
  const tokenPair = rec.agentMeta
    ? fmtTokenPair(rec.agentMeta.inputTokens, rec.agentMeta.outputTokens)
    : null;
  const metaBit = rec.agentMeta
    ? `<span class="mono" style="color:var(--muted);font-weight:400">&middot; ${fmtMs(rec.agentMeta.durationMs)} &middot; ${fmtUsd(recordCostUsd(rec))}${
        tokenPair ? ` &middot; ${tokenPair}` : ''
      }${rec.agentMeta.numTurns != null ? ` &middot; ${rec.agentMeta.numTurns} turns` : ''}</span>`
    : '';
  const head = `<div class="rep-head">rep ${rec.rep} ${statusChip(rec.status)} ${scoreBit} ${metaBit}</div>`;

  const skipNote =
    rec.status !== 'ok' && rec.skipReason ? `<div class="na">reason: ${esc(rec.skipReason)}</div>` : '';

  let dimsTable = '';
  let diffsList = '';
  let judgeNote = '';
  if (rec.result) {
    const dims = Object.values(rec.result.dimensions);
    if (dims.length) {
      dimsTable = `<div class="scroll-x"><table><thead><tr><th>dimension</th><th class="num">score</th><th>gate</th></tr></thead>
        <tbody>${dims
          .map((d) => `<tr><td>${esc(d.dimension)}</td><td class="num">${fmtScore(d.score)}</td><td>${gateChip(d.gate)}</td></tr>`)
          .join('')}</tbody></table></div>`;
    }

    const diffs = rec.result.diffs;
    if (diffs.length) {
      diffsList = `<div class="scroll-x"><table><thead><tr><th>dimension</th><th>message</th><th>fix</th></tr></thead>
        <tbody>${diffs
          .map(
            (d) =>
              `<tr class="diff-row"><td>${esc(d.dimension)}</td><td class="msg">${esc(d.message)}</td><td class="fix">${d.fix ? esc(d.fix) : 'n/a'}</td></tr>`,
          )
          .join('')}</tbody></table></div>`;
    }

    const judgeDiffs = diffs.filter((d) => d.dimension === 'judgment');
    if (judgeDiffs.length) {
      judgeNote = `<div class="judge-note"><b>Judge reasoning</b><ul style="margin:6px 0 0;padding-left:18px">${judgeDiffs
        .map((d) => `<li>${esc(d.message)}${d.fix ? ` &mdash; <span style="color:var(--muted)">${esc(d.fix)}</span>` : ''}</li>`)
        .join('')}</ul></div>`;
    }
  }

  const links: string[] = [];
  if (rec.artifacts?.dir) links.push(`<a href="${esc(rec.artifacts.dir)}">artifacts/</a>`);
  if (rec.artifacts?.diffPatch) links.push(`<a href="${esc(rec.artifacts.diffPatch)}">diff.patch</a>`);
  if (rec.artifacts?.transcript) links.push(`<a href="${esc(rec.artifacts.transcript)}">transcript.jsonl</a>`);
  const linksHtml = links.length ? `<div class="links">${links.join('')}</div>` : '';

  return `<div class="rep-card">
    ${head}
    ${skipNote}
    ${dimsTable}
    ${diffsList}
    ${judgeNote}
    ${linksHtml}
  </div>`;
}

function renderDrill(taskId: string, col: ColumnInfo, agg: Aggregate | undefined, recs: CellRecord[]): string {
  const id = domId(taskId, col.cellKey);
  const aggLine = agg
    ? `mean ${fmtScore(agg.meanOverall)} · std ${agg.stdOverall.toFixed(1)} · n=${agg.n} · gate ${agg.worstGate} · dims: ${
        Object.entries(agg.meanDimensions)
          .map(([k, v]) => `${k}=${v.toFixed(1)}`)
          .join(', ') || 'n/a'
      }`
    : 'No successful reps for this cell.';

  const reps = [...recs].sort((a, b) => a.rep - b.rep).map(renderRepCard).join('');

  return `<div class="drill" id="${id}" hidden>
    <h4>${esc(taskId)} <span class="mono" style="color:var(--muted)">&middot; ${esc(col.cellKey)}</span></h4>
    <div class="agg-line">${esc(aggLine)}</div>
    ${reps}
  </div>`;
}

interface ColumnSummary {
  meanOfMeans: number | null;
  totalCost: number | null;
  tokenPair: string | null;
  meanDuration: number | null;
  taskCount: number;
}

function columnSummary(col: ColumnInfo, results: RunResults): ColumnSummary {
  const aggs = results.aggregates.filter((a) => a.cellKey === col.cellKey);
  const meanOfMeans = aggs.length ? aggs.reduce((s, a) => s + a.meanOverall, 0) / aggs.length : null;

  const recs = results.records.filter((r) => cellKey(r.cell) === col.cellKey);
  const costs = recs.map(recordCostUsd).filter((v): v is number => v != null);
  const totalCost = costs.length ? costs.reduce((a, b) => a + b, 0) : null;
  const inputs = recs.map((r) => r.agentMeta?.inputTokens).filter((v): v is number => v != null);
  const outputs = recs.map((r) => r.agentMeta?.outputTokens).filter((v): v is number => v != null);
  const tokenPair = fmtTokenPair(
    inputs.length ? inputs.reduce((a, b) => a + b, 0) : null,
    outputs.length ? outputs.reduce((a, b) => a + b, 0) : null,
  );
  const durations = recs.map((r) => r.agentMeta?.durationMs).filter((v): v is number => v != null);
  const meanDuration = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

  return { meanOfMeans, totalCost, tokenPair, meanDuration, taskCount: aggs.length };
}

function renderSystemTable(
  system: SystemId,
  columns: ColumnInfo[],
  taskIds: string[],
  results: RunResults,
  aggByKey: Map<string, Aggregate>,
  recordsByKey: Map<string, CellRecord[]>,
): string {
  const headerRow = `<tr>
    <th class="task-name">task</th>
    ${columns.map((c) => `<th>${esc(c.context)}<br><span class="mono" style="color:var(--muted)">${esc(c.model)}</span></th>`).join('')}
  </tr>`;

  const bodyRows = taskIds
    .map((taskId) => {
      const cells = columns
        .map((col) => {
          const key = `${taskId}::${col.cellKey}`;
          return renderMatrixCell(taskId, col, aggByKey.get(key), recordsByKey.get(key));
        })
        .join('');
      return `<tr><td class="task-name">${esc(taskId)}</td>${cells}</tr>`;
    })
    .join('');

  const summaries = columns.map((c) => columnSummary(c, results));
  const summaryRow = `<tr>
    <td class="task-name">column mean &middot; cost &middot; avg duration</td>
    ${summaries
      .map(
        (s) => `<td>
      <div class="mono" style="font-weight:700">${s.meanOfMeans != null ? fmtScore(s.meanOfMeans) : 'n/a'}</div>
      <div class="mx-n">${fmtUsd(s.totalCost)}${s.tokenPair ? ` &middot; ${s.tokenPair}` : ''} &middot; ${fmtMs(s.meanDuration)}</div>
    </td>`,
      )
      .join('')}
  </tr>`;

  const drilldowns = taskIds
    .flatMap((taskId) =>
      columns.map((col) => {
        const key = `${taskId}::${col.cellKey}`;
        const recs = recordsByKey.get(key);
        if (!recs || recs.length === 0) return '';
        return renderDrill(taskId, col, aggByKey.get(key), recs);
      }),
    )
    .join('');

  return `<div class="card matrix-system">
    <h3>${esc(system)}</h3>
    <div class="scroll-x">
      <table class="matrix">
        <thead>${headerRow}</thead>
        <tbody>${bodyRows}</tbody>
        <tfoot>${summaryRow}</tfoot>
      </table>
    </div>
  </div>
  <div class="drilldowns">${drilldowns}</div>`;
}

function renderMatrix(results: RunResults): string {
  const columns = collectColumns(results);
  const taskIds = collectTaskIds(results);
  const groups = groupColumnsBySystem(columns);

  const aggByKey = new Map<string, Aggregate>();
  for (const a of results.aggregates) aggByKey.set(`${a.taskId}::${a.cellKey}`, a);

  const recordsByKey = new Map<string, CellRecord[]>();
  for (const rec of results.records) {
    const key = `${rec.taskId}::${cellKey(rec.cell)}`;
    const arr = recordsByKey.get(key);
    if (arr) arr.push(rec);
    else recordsByKey.set(key, [rec]);
  }

  return groups
    .map((g) => renderSystemTable(g.system, g.columns, taskIds, results, aggByKey, recordsByKey))
    .join('');
}

const TOGGLE_SCRIPT = `
function toggleDrill(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.hidden = !el.hidden;
  if (!el.hidden && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
`;

export function renderReportHtml(results: RunResults): string {
  const body = `<main class="wrap">
  ${renderHeader(results)}

  <section>
    <h2>Benchmark matrix</h2>
    <p class="lede">One table per system. Rows are tasks, columns are context &times; model. Each cell is the mean
      overall score across ok reps; colour follows the score (green &ge;85, yellow &ge;60, red below).
      Gate (pass / review / fail) lives in the drill-down, not on the grid. The column summary row &mdash;
      mean of means, total cost, average duration &mdash; is the headline comparison across context levels.
      Click any cell to expand per-rep detail.</p>
    ${renderMatrix(results)}
  </section>

  <footer class="foot">
    Run <code>${esc(results.runId)}</code> &middot; ${results.records.length} record(s) &middot;
    ${results.aggregates.length} aggregate(s). Generated by <code>open-ds-bench</code>.
  </footer>
</main>
${jsonScript('report-data', results)}`;

  return page(`open-ds-bench · ${results.manifest.label ?? results.runId}`, body, TOGGLE_SCRIPT);
}

// Re-exported so compare.ts (and tests) don't need a second definition path.
export type { ColumnInfo };
export { collectColumns, collectTaskIds };
