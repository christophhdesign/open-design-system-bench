// Everything numeric in a report, computed once.
//
// This module is the reason an AI-readiness report can be trusted: `report
// --stats` renders these blocks for an authoring agent to paste in verbatim,
// and `report --validate` re-renders them from the same function and requires a
// byte match. An agent that retypes a digit is caught. It never has to do
// arithmetic over twenty cells, so it never gets the arithmetic wrong.
//
// Pure and side-effect free. Callers own reading results.json and running the
// audit checks.

import { dump } from 'js-yaml';
import { rubric } from '../../rubric.config.ts';
import type { AuditCheckResult } from '../audit/types.ts';
import type { AuditScore } from '../audit/score.ts';
import type { CellRecord, CellStatus, Gate, RunResults, SystemConfig, SystemId } from '../types.ts';
import { cellKey } from '../types.ts';
import { contextRank, fmtMs, fmtUsd } from './shared.ts';

// ---------------------------------------------------------------------------
// The canonical outline
// ---------------------------------------------------------------------------

export interface OutlineSection {
  /** Heading number as it appears in the document: "1", "2.1", "A". */
  number: string;
  title: string;
  /** Markdown heading depth. */
  level: 2 | 3;
  /**
   * `generated` sections must byte-match renderStatsBlocks() output.
   * `agent` sections are the interpretation layer and are free prose.
   */
  source: 'generated' | 'agent';
}

/**
 * Fixed, ordered and closed. Structural identity is what lets two reports of
 * the same system diff, and two different systems be read side by side.
 * `report --validate` fails on a missing, renamed or reordered heading.
 */
export const REPORT_OUTLINE: OutlineSection[] = [
  { number: '1', title: 'Executive summary', level: 2, source: 'generated' },
  { number: '2', title: 'Methodology', level: 2, source: 'agent' },
  { number: '2.1', title: 'What the benchmark does', level: 3, source: 'generated' },
  { number: '2.2', title: 'Configuration used', level: 3, source: 'generated' },
  { number: '2.3', title: 'Extraction results', level: 3, source: 'generated' },
  { number: '2.4', title: 'Fixture deviations', level: 3, source: 'agent' },
  { number: '3', title: 'What each axis measures', level: 2, source: 'generated' },
  { number: '4', title: 'Results', level: 2, source: 'agent' },
  { number: '4.1', title: 'All cells', level: 3, source: 'generated' },
  { number: '4.2', title: 'By context', level: 3, source: 'generated' },
  { number: '5', title: 'Findings', level: 2, source: 'agent' },
  { number: '6', title: 'Notable individual results', level: 2, source: 'agent' },
  { number: '7', title: 'Harness defects', level: 2, source: 'agent' },
  { number: '8', title: 'Validity limits', level: 2, source: 'agent' },
  { number: '9', title: 'Recommendations', level: 2, source: 'agent' },
  { number: 'A', title: 'Task suite', level: 2, source: 'generated' },
  { number: 'B', title: 'Reproducing', level: 2, source: 'generated' },
];

/**
 * `## 1. Executive summary`, `### 2.1 What the benchmark does`,
 * `## Appendix A - Task suite`. Top-level sections take a trailing period after
 * the number, sub-sections do not, which is the convention the reference report
 * uses and the one `--validate` enforces.
 */
export function headingFor(section: OutlineSection): string {
  const hashes = '#'.repeat(section.level);
  if (/^[A-Z]$/.test(section.number)) {
    return `${hashes} Appendix ${section.number} - ${section.title}`;
  }
  const separator = section.number.includes('.') ? '' : '.';
  return `${hashes} ${section.number}${separator} ${section.title}`;
}

// ---------------------------------------------------------------------------
// Computed shapes
// ---------------------------------------------------------------------------

export interface StatsCell {
  index: number;
  taskId: string;
  context: string;
  model: string;
  cellKey: string;
  rep: number;
  status: CellStatus;
  overall: number | null;
  gate: Gate | null;
  dimensions: Record<string, number>;
  /** POSIX-normalized. Run data stores these with Windows separators. */
  artifactsDir: string | null;
}

export interface ContextStats {
  context: string;
  cellCount: number;
  meanOverall: number;
  dimensionMeans: Record<string, number>;
  gateCounts: Record<Gate, number>;
}

/** One thing the report is required to address. What it *says* is the agent's own. */
export type CoverageItem =
  | { key: string; label: string; match: { kind: 'cell'; cellKey: string; taskId: string; rep: number } }
  | { key: string; label: string; match: { kind: 'dimension'; dimension: string } }
  | { key: string; label: string; match: { kind: 'auditCheck'; checkId: string } };

/** Advisory only, and deliberately outside the schema: starting points, not pre-written findings. */
export interface Lead {
  headline: string;
  detail: string[];
}

/** Extraction counts, read straight off the committed catalog/token snapshots. */
export interface ExtractionCounts {
  components: number;
  exports: number;
  props: number;
  cssVars: number;
  utilities: number;
}

export interface ReportStats {
  systemId: SystemId;
  primaryRunId: string;
  /** Null when the catalog has not been extracted in this checkout. */
  extraction: ExtractionCounts | null;
  agents: string[];
  cells: StatsCell[];
  taskIds: string[];
  contexts: string[];
  dimensionIds: string[];
  summary: {
    cellCount: number;
    okCount: number;
    erroredCount: number;
    meanOverall: number;
    medianOverall: number;
    minOverall: number;
    maxOverall: number;
    gateCounts: Record<Gate, number>;
    perfectCells: number;
    costUsd: number | null;
    wallClockMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    dimensionMeans: Record<string, number>;
  };
  byContext: ContextStats[];
  auditChecks: AuditCheckResult[];
  auditScore: AuditScore;
  coverage: CoverageItem[];
  leads: Lead[];
  /**
   * Every number the prose may quote without declaring a citedFigure. See
   * buildAllowedNumbers for exactly what is in here and why.
   */
  allowedNumbers: number[];
  config: SystemConfig;
}

// ---------------------------------------------------------------------------
// Formatting (shared by render and re-render, so they cannot disagree)
// ---------------------------------------------------------------------------

/** Overall scores carry two decimals, matching how a composite is quoted. */
export function fmtOverall(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return 'n/a';
  return n.toFixed(2);
}

/** Dimension and axis scores carry one. */
export function fmtDim(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return 'n/a';
  return n.toFixed(1);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function emptyGates(): Record<Gate, number> {
  return { pass: 0, review: 0, fail: 0 };
}

function toPosix(p: string | undefined): string | null {
  return p ? p.replace(/\\/g, '/') : null;
}

function mdTable(headers: string[], rows: string[][]): string {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

// ---------------------------------------------------------------------------
// buildReportStats
// ---------------------------------------------------------------------------

/** Dimension display order follows rubric.config.ts, not object key order. */
const DIMENSION_ORDER = Object.keys(rubric.weights);

function orderDimensions(ids: Iterable<string>): string[] {
  const seen = [...new Set(ids)];
  return seen.sort((a, b) => {
    const ai = DIMENSION_ORDER.indexOf(a);
    const bi = DIMENSION_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

export function buildReportStats(
  run: RunResults,
  systemId: SystemId,
  config: SystemConfig,
  auditChecks: AuditCheckResult[],
  auditScore: AuditScore,
  extraction: ExtractionCounts | null,
): ReportStats {
  const records = run.records
    .filter((r) => r.cell.system === systemId)
    .sort((a, b) => {
      const byTask = a.taskId.localeCompare(b.taskId);
      if (byTask !== 0) return byTask;
      const byContext = contextRank(a.cell.context) - contextRank(b.cell.context);
      if (byContext !== 0) return byContext;
      const byModel = a.cell.model.localeCompare(b.cell.model);
      if (byModel !== 0) return byModel;
      return a.rep - b.rep;
    });

  const cells: StatsCell[] = records.map((rec, i) => ({
    index: i + 1,
    taskId: rec.taskId,
    context: rec.cell.context,
    model: rec.cell.model,
    cellKey: cellKey(rec.cell),
    rep: rec.rep,
    status: rec.status,
    overall: rec.result ? rec.result.overall : null,
    gate: rec.result ? rec.result.gate : null,
    dimensions: rec.result
      ? Object.fromEntries(Object.entries(rec.result.dimensions).map(([id, d]) => [id, d.score]))
      : {},
    artifactsDir: toPosix(rec.artifacts?.dir),
  }));

  const ok = cells.filter((c) => c.overall !== null);
  const overalls = ok.map((c) => c.overall as number);

  const gateCounts = emptyGates();
  for (const c of ok) if (c.gate) gateCounts[c.gate] += 1;

  const dimensionIds = orderDimensions(ok.flatMap((c) => Object.keys(c.dimensions)));
  const dimensionMeans: Record<string, number> = {};
  for (const dim of dimensionIds) {
    const scores = ok.map((c) => c.dimensions[dim]).filter((s): s is number => typeof s === 'number');
    if (scores.length > 0) dimensionMeans[dim] = mean(scores);
  }

  const contexts = [...new Set(cells.map((c) => c.context))].sort((a, b) => contextRank(a) - contextRank(b));
  const byContext: ContextStats[] = contexts.map((context) => {
    const inContext = ok.filter((c) => c.context === context);
    const gates = emptyGates();
    for (const c of inContext) if (c.gate) gates[c.gate] += 1;
    const means: Record<string, number> = {};
    for (const dim of dimensionIds) {
      const scores = inContext.map((c) => c.dimensions[dim]).filter((s): s is number => typeof s === 'number');
      if (scores.length > 0) means[dim] = mean(scores);
    }
    return {
      context,
      cellCount: inContext.length,
      meanOverall: mean(inContext.map((c) => c.overall as number)),
      dimensionMeans: means,
      gateCounts: gates,
    };
  });

  const summary = {
    cellCount: cells.length,
    okCount: ok.length,
    erroredCount: cells.length - ok.length,
    meanOverall: mean(overalls),
    medianOverall: median(overalls),
    minOverall: overalls.length > 0 ? Math.min(...overalls) : 0,
    maxOverall: overalls.length > 0 ? Math.max(...overalls) : 0,
    gateCounts,
    // 99.995 rather than 100: a weighted mean of six 100s can land a hair under.
    perfectCells: ok.filter((c) => (c.overall as number) >= 99.995).length,
    costUsd: run.manifest.totalCostUsd ?? null,
    wallClockMs: run.manifest.wallClockMs ?? null,
    inputTokens: run.manifest.totalInputTokens ?? null,
    outputTokens: run.manifest.totalOutputTokens ?? null,
    dimensionMeans,
  };

  const taskIds = [...new Set(cells.map((c) => c.taskId))].sort();

  return {
    systemId,
    primaryRunId: run.runId,
    extraction,
    agents: [...new Set(records.map((r) => r.cell.agent))].sort(),
    cells,
    taskIds,
    contexts,
    dimensionIds,
    summary,
    byContext,
    auditChecks,
    auditScore,
    coverage: buildCoverage(cells, records, auditChecks),
    leads: buildLeads(cells, records, auditChecks),
    allowedNumbers: buildAllowedNumbers({ cells, summary, byContext, dimensionIds, auditChecks, auditScore, taskIds, extraction }),
    config,
  };
}

// ---------------------------------------------------------------------------
// Coverage: what the report must address
// ---------------------------------------------------------------------------

/** Audit checks at or below this are treated as a finding the report owes an explanation for. */
export const AUDIT_CHECK_COVERAGE_THRESHOLD = 70;
/** A judged cell below this is a design-quality result worth writing up. */
export const JUDGMENT_COVERAGE_THRESHOLD = 60;

function buildCoverage(cells: StatsCell[], records: CellRecord[], auditChecks: AuditCheckResult[]): CoverageItem[] {
  const items: CoverageItem[] = [];

  for (const c of cells) {
    if (c.gate === 'fail') {
      items.push({
        key: `cell-fail:${c.cellKey}/${c.taskId}/rep${c.rep}`,
        label: `hard failure: ${c.taskId} (${c.context}) gated fail`,
        match: { kind: 'cell', cellKey: c.cellKey, taskId: c.taskId, rep: c.rep },
      });
    }
    const judgment = c.dimensions.judgment;
    if (typeof judgment === 'number' && judgment < JUDGMENT_COVERAGE_THRESHOLD) {
      items.push({
        key: `judgment-low:${c.cellKey}/${c.taskId}/rep${c.rep}`,
        label: `judgment ${fmtDim(judgment)}: ${c.taskId} (${c.context})`,
        match: { kind: 'cell', cellKey: c.cellKey, taskId: c.taskId, rep: c.rep },
      });
    }
  }

  // Every dimension that ever gated review has to be explained somewhere, even
  // though the individual cells do not each need their own finding.
  const reviewDimensions = new Set<string>();
  for (const rec of records) {
    if (!rec.result) continue;
    for (const [dimId, dim] of Object.entries(rec.result.dimensions)) {
      if (dim.gate === 'review') reviewDimensions.add(dimId);
    }
  }
  for (const dimension of orderDimensions(reviewDimensions)) {
    items.push({
      key: `review-dimension:${dimension}`,
      label: `${dimension} gated review on at least one cell`,
      match: { kind: 'dimension', dimension },
    });
  }

  for (const check of auditChecks) {
    const lowScore = check.score !== null && check.score < AUDIT_CHECK_COVERAGE_THRESHOLD;
    const hasFail = check.findings.some((f) => f.severity === 'fail');
    // Vocabulary divergences arrive as warn findings and never move the score
    // much, so they would otherwise slip past both tests above.
    const vocabWarn = check.id === 'vocabulary' && check.findings.some((f) => f.severity === 'warn');
    if (!lowScore && !hasFail && !vocabWarn) continue;
    const reason = lowScore ? `scored ${fmtDim(check.score)}` : hasFail ? 'has a failing finding' : 'reports divergences';
    items.push({
      key: `audit-check:${check.id}`,
      label: `audit check "${check.title}" ${reason}`,
      match: { kind: 'auditCheck', checkId: check.id },
    });
  }

  return items;
}

function buildLeads(cells: StatsCell[], records: CellRecord[], auditChecks: AuditCheckResult[]): Lead[] {
  const leads: Lead[] = [];

  for (const c of cells.filter((x) => x.gate === 'fail')) {
    const rec = records.find((r) => cellKey(r.cell) === c.cellKey && r.taskId === c.taskId && r.rep === c.rep);
    const diffs = (rec?.result?.diffs ?? []).map((d) => `${d.dimension}: ${d.message}`);
    leads.push({
      headline: `FAIL  ${c.taskId} (${c.context}) overall ${fmtOverall(c.overall)}`,
      detail: diffs.length > 0 ? diffs : ['no diffs recorded'],
    });
  }

  for (const c of cells) {
    const judgment = c.dimensions.judgment;
    if (typeof judgment !== 'number' || judgment >= JUDGMENT_COVERAGE_THRESHOLD) continue;
    const rec = records.find((r) => cellKey(r.cell) === c.cellKey && r.taskId === c.taskId && r.rep === c.rep);
    const notes = (rec?.result?.diffs ?? []).filter((d) => d.dimension === 'judgment').map((d) => d.message);
    leads.push({
      headline: `JUDGE ${c.taskId} (${c.context}) judgment ${fmtDim(judgment)}`,
      detail: notes.length > 0 ? notes : ['no judge reasoning recorded'],
    });
  }

  for (const check of auditChecks) {
    const notable = check.findings.filter((f) => f.severity !== 'info');
    if (notable.length === 0) continue;
    leads.push({
      headline: `AUDIT ${check.title} ${fmtDim(check.score)}`,
      detail: notable.map((f) => `[${f.severity}] ${f.message}${f.fix ? ` (fix: ${f.fix})` : ''}`),
    });
  }

  for (const c of cells.filter((x) => x.status !== 'ok')) {
    leads.push({
      headline: `${c.status.toUpperCase()}  ${c.taskId} (${c.context})`,
      detail: ['cell produced no result and is excluded from every mean'],
    });
  }

  return leads;
}

// ---------------------------------------------------------------------------
// Numeric provenance
// ---------------------------------------------------------------------------

/** Every number appearing in a machine-written string. Quoting the tool is always legitimate. */
function harvestNumbers(text: string, into: Set<number>): void {
  for (const match of text.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const n = Number(match[0]);
    if (Number.isFinite(n)) into.add(n);
  }
}

/**
 * The set of numbers prose may quote without declaring a citedFigure.
 *
 * Deliberately generous, because a false positive here costs an author a
 * pointless citedFigures entry while a false negative lets an invented number
 * through. It contains:
 *
 *  - every raw and rounded score, mean, count and gate tally
 *  - every number inside a generated string (audit findings, judge reasoning,
 *    grader diffs) - the agent is quoting the tool, not asserting
 *  - context-to-context deltas per task and per dimension, which is the
 *    comparison the benchmark exists to make
 *  - each cell's distance from 100
 *  - per-dimension counts of cells at 100 and not at 100 ("17 of 20 cells")
 *
 * Anything else - a count derived by reading the design system's source, a
 * reference count in a token file - is real analysis and must be declared in
 * citedFigures with its source and method.
 */
function buildAllowedNumbers(input: {
  cells: StatsCell[];
  summary: ReportStats['summary'];
  byContext: ContextStats[];
  dimensionIds: string[];
  auditChecks: AuditCheckResult[];
  auditScore: AuditScore;
  taskIds: string[];
  extraction: ExtractionCounts | null;
}): number[] {
  const out = new Set<number>();
  const add = (n: number | null | undefined): void => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return;
    out.add(n);
    out.add(Number(n.toFixed(1)));
    out.add(Number(n.toFixed(2)));
    out.add(Math.round(n));
  };

  const { cells, summary, byContext, dimensionIds, auditChecks, auditScore } = input;

  add(summary.cellCount);
  add(summary.okCount);
  add(summary.erroredCount);
  add(summary.meanOverall);
  add(summary.medianOverall);
  add(summary.minOverall);
  add(summary.maxOverall);
  add(summary.perfectCells);
  add(summary.costUsd);
  add(summary.inputTokens);
  add(summary.outputTokens);
  add(input.taskIds.length);
  if (input.extraction) for (const v of Object.values(input.extraction)) add(v);
  for (const g of Object.values(summary.gateCounts)) add(g);
  for (const v of Object.values(summary.dimensionMeans)) add(v);
  if (summary.wallClockMs != null) {
    add(summary.wallClockMs);
    add(summary.wallClockMs / 1000);
    add(summary.wallClockMs / 60000);
  }

  for (const c of cells) {
    add(c.overall);
    add(c.rep);
    if (c.overall != null) add(100 - c.overall);
    for (const v of Object.values(c.dimensions)) {
      add(v);
      add(100 - v);
    }
  }

  for (const ctx of byContext) {
    add(ctx.cellCount);
    add(ctx.meanOverall);
    for (const v of Object.values(ctx.dimensionMeans)) add(v);
    for (const g of Object.values(ctx.gateCounts)) add(g);
  }

  // Context-to-context deltas: overall means, per-dimension means, and the
  // same task compared across contexts.
  for (let i = 0; i < byContext.length; i += 1) {
    for (let j = 0; j < byContext.length; j += 1) {
      if (i === j) continue;
      add(byContext[i].meanOverall - byContext[j].meanOverall);
      for (const dim of dimensionIds) {
        const a = byContext[i].dimensionMeans[dim];
        const b = byContext[j].dimensionMeans[dim];
        if (typeof a === 'number' && typeof b === 'number') add(a - b);
      }
    }
  }
  for (const taskId of input.taskIds) {
    const forTask = cells.filter((c) => c.taskId === taskId && c.overall !== null);
    for (const a of forTask) {
      for (const b of forTask) {
        if (a === b) continue;
        add((a.overall as number) - (b.overall as number));
        for (const dim of dimensionIds) {
          const av = a.dimensions[dim];
          const bv = b.dimensions[dim];
          if (typeof av === 'number' && typeof bv === 'number') add(av - bv);
        }
      }
    }
  }

  // "17 of 20 cells scored 100 on imports"
  const okCells = cells.filter((c) => c.overall !== null);
  for (const dim of dimensionIds) {
    const scored = okCells.filter((c) => typeof c.dimensions[dim] === 'number');
    const atCeiling = scored.filter((c) => c.dimensions[dim] >= 99.995).length;
    add(atCeiling);
    add(scored.length - atCeiling);
  }

  add(auditScore.composite);
  add(auditScore.surface.score);
  // Surface carries a per-check breakdown rather than a note. The behavioral
  // four each carry a note whose numbers (guided mean, non-fail rate) reports
  // quote directly, so those are harvested too.
  for (const axis of [auditScore.lift, auditScore.ceiling, auditScore.engagement, auditScore.vocabularyBehavioral]) {
    add(axis.score);
    add(axis.raw);
    harvestNumbers(axis.note, out);
  }
  harvestNumbers(auditScore.tierRationale, out);
  for (const check of auditChecks) {
    add(check.score);
    for (const f of check.findings) {
      harvestNumbers(f.message, out);
      if (f.fix) harvestNumbers(f.fix, out);
    }
  }

  // Dimension weights, quoted constantly when explaining a composite.
  for (const w of Object.values(rubric.weights)) {
    add(w);
    add(w * 100);
  }

  return [...out].sort((a, b) => a - b);
}

/** Harvests the numbers in every grader diff and judge note, which prose may quote. */
export function harvestRecordNumbers(records: CellRecord[]): number[] {
  const out = new Set<number>();
  for (const rec of records) {
    for (const d of rec.result?.diffs ?? []) {
      harvestNumbers(d.message, out);
      if (d.fix) harvestNumbers(d.fix, out);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Generated front matter
// ---------------------------------------------------------------------------

/** The subset of front matter that is computed, not authored. */
export function buildGeneratedFrontMatter(stats: ReportStats, run: RunResults): Record<string, unknown> {
  const s = stats.summary;
  const round = (n: number | null): number | null => (n === null ? null : Number(n.toFixed(4)));
  const roundMap = (m: Record<string, number>): Record<string, number> =>
    Object.fromEntries(stats.dimensionIds.filter((d) => d in m).map((d) => [d, Number(m[d].toFixed(4))]));

  const axis = (a: { score: number | null; raw?: number }): Record<string, unknown> => {
    const out: Record<string, unknown> = { score: round(a.score) };
    if (a.raw !== undefined) out.raw = Number(a.raw.toFixed(4));
    return out;
  };

  return {
    results: {
      cellCount: s.cellCount,
      okCount: s.okCount,
      erroredCount: s.erroredCount,
      meanOverall: round(s.meanOverall),
      medianOverall: round(s.medianOverall),
      minOverall: round(s.minOverall),
      maxOverall: round(s.maxOverall),
      gateCounts: s.gateCounts,
      perfectCells: s.perfectCells,
      costUsd: round(s.costUsd),
      wallClockMs: s.wallClockMs,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      dimensionMeans: roundMap(s.dimensionMeans),
      byContext: stats.byContext.map((c) => ({
        context: c.context,
        cellCount: c.cellCount,
        meanOverall: round(c.meanOverall),
        dimensionMeans: roundMap(c.dimensionMeans),
        gateCounts: c.gateCounts,
      })),
    },
    audit: {
      basis: stats.auditScore.basis,
      composite: round(stats.auditScore.composite),
      tier: stats.auditScore.tier,
      axes: {
        surface: axis(stats.auditScore.surface),
        lift: axis(stats.auditScore.lift),
        ceiling: axis(stats.auditScore.ceiling),
        engagement: axis(stats.auditScore.engagement),
        vocabularyBehavioral: axis(stats.auditScore.vocabularyBehavioral),
      },
      surfaceChecks: Object.fromEntries(stats.auditChecks.map((c) => [c.id, round(c.score)])),
    },
    provenance: {
      runs: [
        {
          runId: run.runId,
          ...(run.manifest.label ? { label: run.manifest.label } : {}),
          profile: run.manifest.profile,
          role: 'primary',
          cellCount: stats.summary.cellCount,
          ...(run.manifest.startedAt ? { startedAt: run.manifest.startedAt } : {}),
          ...(run.manifest.finishedAt ? { finishedAt: run.manifest.finishedAt } : {}),
        },
      ],
      ...(stats.extraction ? { catalog: stats.extraction } : {}),
    },
    methodology: {
      consume: stats.config.consume ?? 'source',
      contexts: stats.contexts,
      models: [...new Set(stats.cells.map((c) => c.model))].sort(),
      agents: stats.agents,
      reps: Math.max(1, ...stats.cells.map((c) => c.rep)),
      comparabilityKey: buildComparabilityKey(stats, run),
    },
  };
}

/**
 * Two reports may only be compared numerically when this matches. The reference
 * report's own warning, made mechanical: a medium run with no bare context
 * cannot be read as a regression from a smoke run that had one, because Lift
 * drops out of the composite entirely.
 */
export function buildComparabilityKey(stats: ReportStats, run: RunResults): string {
  const parts = [
    `profile=${run.manifest.profile}`,
    `contexts=${stats.contexts.join(',')}`,
    `reps=${Math.max(1, ...stats.cells.map((c) => c.rep))}`,
    `consume=${stats.config.consume ?? 'source'}`,
    `fixture=${stats.config.fixtureTemplate ?? `fixtures/${stats.systemId}-app`}`,
    `tasks=${stats.taskIds.length}`,
  ];
  return parts.join(';');
}

// ---------------------------------------------------------------------------
// Generated markdown blocks
// ---------------------------------------------------------------------------

export type SectionBlocks = Record<string, string>;

/**
 * The generated half of the report, keyed by outline section number. Paste
 * verbatim; `report --validate` re-renders these and requires a byte match.
 */
export function renderStatsBlocks(stats: ReportStats): SectionBlocks {
  return {
    '1': renderExecutiveSummary(stats),
    '2.1': renderWhatTheBenchmarkDoes(),
    '2.2': renderConfiguration(stats),
    '2.3': renderExtraction(stats),
    '3': renderAxisPrimer(stats),
    '4.1': renderAllCells(stats),
    '4.2': renderByContext(stats),
    A: renderTaskSuite(stats),
    B: renderReproducing(stats),
  };
}

function renderExecutiveSummary(stats: ReportStats): string {
  const s = stats.summary;
  const g = s.gateCounts;
  const rows: string[][] = [
    [`Mean score across ${s.okCount} graded cells`, `**${fmtOverall(s.meanOverall)} / 100**`],
    ['Median', fmtOverall(s.medianOverall)],
    ['Range', `${fmtOverall(s.minOverall)} - ${fmtOverall(s.maxOverall)}`],
    ['Gate outcomes', `${g.pass} pass / ${g.review} review / ${g.fail} fail`],
    ['Perfect cells', String(s.perfectCells)],
  ];
  if (s.erroredCount > 0) rows.push(['Cells with no result', String(s.erroredCount)]);
  rows.push(['AI-Readiness composite', `${fmtDim(stats.auditScore.composite)} (${stats.auditScore.tier}, ${stats.auditScore.basis})`]);
  rows.push(['Cost', fmtUsd(s.costUsd)]);
  rows.push(['Wall clock', fmtMs(s.wallClockMs)]);
  return mdTable(['Metric', 'Value'], rows);
}

function renderWhatTheBenchmarkDoes(): string {
  return [
    'The harness issues intent-level task prompts to a headless coding agent inside a disposable',
    'fixture workspace that consumes the design system under test. Task prompts never name a',
    'component: they describe a user-facing outcome. The generated diff is then graded across six',
    'dimensions, five mechanical (deterministic, AST- and compiler-based) and one model-judged.',
    '',
    'Each task runs at one or more context levels, which control how much guidance the agent receives:',
    '',
    mdTable(
      ['Context', 'Injected into the workspace'],
      [
        ['`bare`', 'Nothing. The agent has only the fixture and whatever the fixture exposes.'],
        ['`agents-md`', 'The files listed in `agentContext.agentsMd`, copied in as both `AGENTS.md` and `CLAUDE.md`.'],
        ['`skill`', 'Everything from `agents-md`, plus skill bundles into `.claude/skills/` and reference docs into `docs/`.'],
      ],
    ),
    '',
    'The comparison between context levels is the point of the exercise. It measures how much a given',
    'documentation layer actually changes agent behaviour, rather than whether the documentation exists.',
  ].join('\n');
}

function renderConfiguration(stats: ReportStats): string {
  // `root` is an absolute path on the machine that ran the benchmark. It is
  // redacted so the block is reproducible and does not leak a directory tree.
  const { root, rootEnv, ...rest } = stats.config;
  void root;
  void rootEnv;
  const snapshot = { root: '<system checkout>', ...rest };
  return ['```json', JSON.stringify(snapshot, null, 2), '```'].join('\n');
}

function renderExtraction(stats: ReportStats): string {
  const catalog = stats.auditChecks.find((c) => c.id === 'catalog-quality');
  const line = catalog?.findings.find((f) => /components=|exports=/.test(f.message))?.message;
  const body = line ?? 'Extraction counts were not recorded by the catalog-quality check for this run.';
  return ['```', body, '```'].join('\n');
}

function renderAxisPrimer(stats: ReportStats): string {
  const weights = rubric.weights as Record<string, number>;
  const descriptions: Record<string, string> = {
    imports:
      'Every import source in the diff, against an allowlist: the system\'s own packages and subpaths, React, the build tool, relative paths, and per-task extras. Detects the agent reaching for an outside UI library instead of the system under test.',
    apiFidelity:
      'That every symbol imported from the system exists in the extracted catalog (hallucinated component), and that every prop passed to a catalogued component is a real prop (invented prop). A diff that imports nothing from the system scores 0: that is the "ignored the library entirely" case.',
    tokenDiscipline:
      'Raw hex colours, `rgb()`/`rgba()` calls, and raw `px`/`rem` dimensions in `className` strings and inline style objects. It does not attempt to validate every utility class against the token list.',
    a11yStatic:
      'A dependency-free reimplementation of eight `eslint-plugin-jsx-a11y` rules over a Babel AST pass. `control-has-name` is the discriminating check: an unlabelled control is a common real failure, which is why the `a11y` vocabulary in the system config matters.',
    compile:
      '`tsc --noEmit` against the generated workspace, type-checking the agent\'s code against the design system\'s real types. This catches genuine API drift whether or not the catalog knows about it.',
    judgment:
      'A separate model evaluates the diff against per-task rubrics authored in the task YAML, each with a weight and an optional `critical` flag. This measures whether the agent made the right design decisions, independent of whether the code compiles.',
  };

  const rows = stats.dimensionIds.map((dim) => [
    `\`${dim}\``,
    weights[dim] !== undefined ? `${(weights[dim] * 100).toFixed(0)}%` : 'n/a',
    descriptions[dim] ?? 'See the grader source.',
  ]);

  return [
    'Six dimensions compose the per-cell score. `overall` is the weighted mean, renormalised over the',
    'dimensions actually present. The gate is the **worst case** across dimensions: a single `fail`',
    'fails the cell regardless of how high the weighted mean is. Weights come from `rubric.config.ts`.',
    '',
    mdTable(['Dimension', 'Weight', 'What it checks'], rows),
    '',
    'Gate policy, as enforced by the graders:',
    '',
    mdTable(
      ['Finding', 'Gate'],
      [
        ['Hallucinated component', '`fail` (the headline metric)'],
        ['Compile error', '`fail`'],
        ['Two or more foreign UI-library imports', '`fail` (exactly one is `review`)'],
        ['Invented prop', '`review` (docgen gaps get human triage)'],
        ['Spread props, unverifiable', 'capped at `review`'],
        ['More than three token violations', '`review`'],
        ['Any static a11y error', '`review`'],
        ['Failed critical judge rubric', '`review` (the judge alone never fails a run)'],
      ],
    ),
    '',
    'Separately, the AI-Readiness Score composes five axes. `Surface` is static and always computable;',
    'the other four need a run. `Lift` needs a `bare` context specifically, and is `n/a` without one.',
    'The `basis` field records which axes could be computed, and composites with different bases are',
    'not comparable to each other.',
  ].join('\n');
}

function renderAllCells(stats: ReportStats): string {
  const dims = stats.dimensionIds;
  const headers = ['#', 'Task', 'Context', ...dims.map((d) => `\`${d}\``), 'Overall', 'Gate'];
  const rows = stats.cells.map((c) => {
    if (c.overall === null) {
      return [
        String(c.index),
        c.taskId,
        c.context,
        ...dims.map(() => '-'),
        '-',
        `_${c.status}_`,
      ];
    }
    return [
      String(c.index),
      c.taskId,
      c.context,
      ...dims.map((d) => (typeof c.dimensions[d] === 'number' ? fmtDim(c.dimensions[d]) : '-')),
      fmtOverall(c.overall),
      c.gate === 'fail' ? '**fail**' : (c.gate as string),
    ];
  });

  const weightLine = stats.dimensionIds
    .map((d) => {
      const w = (rubric.weights as Record<string, number>)[d];
      return w === undefined ? d : `${d} ${(w * 100).toFixed(0)}%`;
    })
    .join(' / ');

  return [`Weights: ${weightLine}`, '', mdTable(headers, rows)].join('\n');
}

function renderByContext(stats: ReportStats): string {
  if (stats.byContext.length === 0) return '_No graded cells._';

  const contexts = stats.byContext;
  const showDelta = contexts.length === 2;
  const headers = ['', ...contexts.map((c) => `\`${c.context}\``), ...(showDelta ? ['Delta'] : [])];

  const rows: string[][] = stats.dimensionIds.map((dim) => {
    const values = contexts.map((c) => c.dimensionMeans[dim]);
    const cells = values.map((v) => (typeof v === 'number' ? fmtDim(v) : 'n/a'));
    if (showDelta && typeof values[0] === 'number' && typeof values[1] === 'number') {
      const delta = values[1] - values[0];
      cells.push(`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
    } else if (showDelta) {
      cells.push('n/a');
    }
    return [`\`${dim}\``, ...cells];
  });

  const overallCells = contexts.map((c) => `**${fmtOverall(c.meanOverall)}**`);
  if (showDelta) {
    const delta = contexts[1].meanOverall - contexts[0].meanOverall;
    overallCells.push(`**${delta >= 0 ? '+' : ''}${delta.toFixed(2)}**`);
  }
  rows.push(['**Mean overall**', ...overallCells]);

  const gateCells = contexts.map((c) => `${c.gateCounts.pass} pass / ${c.gateCounts.review} review / ${c.gateCounts.fail} fail`);
  if (showDelta) gateCells.push('');
  rows.push(['Gates', ...gateCells]);

  const countCells = contexts.map((c) => String(c.cellCount));
  if (showDelta) countCells.push('');
  rows.push(['Cells', ...countCells]);

  return mdTable(headers, rows);
}

function renderTaskSuite(stats: ReportStats): string {
  const count = stats.taskIds.length;
  return [
    `${count} intent-level task${count === 1 ? '' : 's'}, none naming a component:`,
    '',
    stats.taskIds.map((t) => `\`${t}\``).join(' - '),
  ].join('\n');
}

function renderReproducing(stats: ReportStats): string {
  return [
    '```bash',
    '# the harness lives outside the design system repo',
    'cd open-design-system-bench',
    'npx tsx src/cli.ts doctor',
    'npx tsx src/cli.ts extract',
    `npx tsx src/cli.ts audit --system ${stats.systemId}`,
    `npx tsx src/cli.ts run --profile <profile> --label <label>`,
    `npx tsx src/cli.ts audit --system ${stats.systemId} --run runs/${stats.primaryRunId}`,
    '```',
    '',
    'Re-scoring without re-running agents, which costs nothing:',
    '',
    '```bash',
    `npx tsx src/cli.ts grade --run runs/${stats.primaryRunId}`,
    '```',
    '',
    'Regenerating this report\'s computed sections, and checking it:',
    '',
    '```bash',
    `npx tsx src/cli.ts report --stats --run runs/${stats.primaryRunId} --system ${stats.systemId}`,
    'npx tsx src/cli.ts report --validate <this file>',
    '```',
    '',
    'Artefacts per cell: `diff.patch`, `transcript.jsonl`, `grades.json`, `judge.json`, and the full',
    'generated `workspace/src`.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The --stats console output
// ---------------------------------------------------------------------------

export interface PriorFinding {
  id: string;
  title: string;
  severity: string;
  status: string;
}

/** The full `report --stats` pack: front matter, generated blocks, coverage, leads. */
export function renderStatsPack(
  stats: ReportStats,
  generatedFrontMatter: Record<string, unknown>,
  prior: PriorFinding[] | null,
): string {
  const blocks = renderStatsBlocks(stats);
  const out: string[] = [];

  out.push('# report --stats');
  out.push('');
  out.push(`System: ${stats.systemId}   Run: ${stats.primaryRunId}   Graded cells: ${stats.summary.okCount}/${stats.summary.cellCount}`);
  out.push('');
  out.push('Everything below is computed. Paste the front matter and the generated sections verbatim.');
  out.push('`report --validate` re-renders them and fails on a byte difference, so do not retype a digit.');
  out.push('');

  out.push('## Front matter (computed fields)');
  out.push('');
  out.push('Merge into the report\'s YAML front matter. The fields not shown here (reportId, title,');
  out.push('author, subject, harness, methodology.deviations, findings, recommendations,');
  out.push('validityLimits, citedFigures) are yours to write.');
  out.push('');
  out.push('```yaml');
  out.push(dump(generatedFrontMatter, { lineWidth: 100, noRefs: true }).trimEnd());
  out.push('```');
  out.push('');

  for (const section of REPORT_OUTLINE) {
    const block = blocks[section.number];
    if (block === undefined) continue;
    out.push(`## Generated section ${section.number} - ${section.title}`);
    out.push('');
    out.push(`Heading to use: \`${headingFor(section)}\``);
    out.push('');
    out.push(block);
    out.push('');
  }

  out.push('## Coverage: what this report must address');
  out.push('');
  if (stats.coverage.length === 0) {
    out.push('Nothing is mandatory for this run. No hard failures, no low audit checks.');
  } else {
    out.push('`report --validate` fails unless each of these is cited by at least one finding.');
    out.push('What you conclude about each is entirely your own judgement.');
    out.push('');
    for (const item of stats.coverage) {
      out.push(`- [${item.key}] ${item.label}`);
    }
  }
  out.push('');

  out.push('## Leads (advisory, not findings)');
  out.push('');
  out.push('Starting points for investigation. Nothing here is pre-written, and you are free to');
  out.push('conclude that any of it is not worth a finding, provided the coverage list above is met.');
  out.push('');
  if (stats.leads.length === 0) {
    out.push('No failures, low judgements or audit warnings in this run.');
  } else {
    for (const lead of stats.leads) {
      out.push(`- ${lead.headline}`);
      for (const d of lead.detail) out.push(`    ${d}`);
    }
  }
  out.push('');

  if (prior) {
    out.push('## Existing finding ids - reuse these');
    out.push('');
    if (prior.length === 0) {
      out.push('The previous report recorded no findings.');
    } else {
      out.push('If the same underlying cause is present in this run, reuse its id. Do not coin a new');
      out.push('one for a defect that already has a name: that is what breaks history. An id you drop');
      out.push('must be carried forward as `fixed` or `wont-fix`, not silently omitted.');
      out.push('');
      for (const f of prior) {
        out.push(`- ${f.id}  (${f.severity}, ${f.status})`);
        out.push(`    ${f.title}`);
      }
    }
    out.push('');
  }

  return out.join('\n');
}
