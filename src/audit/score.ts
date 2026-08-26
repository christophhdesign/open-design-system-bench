// Assembles the AI-Readiness Score: one composite, five named sub-scores,
// every input tool-derived (ROADMAP.md, "The AI-Readiness Score"). Surface
// is always computable from a static audit alone. The other four —
// Lift, Ceiling, Engagement, Vocabulary-behavioral — need a RunResults file
// from an actual `run` (see src/cli.ts's `audit --run <dir>`); without one
// they're reported as null with a clear note, never silently dropped.

import type { Diff, RunResults } from '../types.ts';
import type { AuditCheckResult } from './types.ts';
import { loadLexicon } from './lexicon.ts';
import { round1, clamp } from './util.ts';

// ---------------------------------------------------------------------------
// Surface (static, always available)
// ---------------------------------------------------------------------------

/**
 * Per-check weights for the Surface sub-score (sum to 100). Surface and
 * catalog-quality are weighted highest — they're #1 and #2 in ROADMAP.md's
 * own "prioritized by evidence-per-dollar" Tier-0 ordering, and every other
 * check either depends on a catalog existing (catalog-quality) or is the
 * asset checklist itself (surface). Export-hygiene and vocabulary are next:
 * both encode a specific, real bug class this project's own extraction work
 * found. Tokens/deprecation/docs-greppability are real but narrower signals.
 */
const SURFACE_CHECK_WEIGHTS: Record<string, number> = {
  surface: 20,
  'catalog-quality': 20,
  'export-hygiene': 15,
  vocabulary: 15,
  tokens: 10,
  deprecation: 10,
  'docs-greppability': 10,
};

export interface SurfaceSubScore {
  score: number; // 0-100
  checks: AuditCheckResult[];
}

/** Weighted mean of whichever checks returned a non-null score; weights of skipped checks are redistributed proportionally rather than counted as 0 — a system with no catalog isn't "bad at tokens", it's unmeasured there. */
export function computeSurfaceScore(checks: AuditCheckResult[]): SurfaceSubScore {
  const present = checks.filter((c) => c.score !== null);
  const totalWeight = present.reduce((sum, c) => sum + (SURFACE_CHECK_WEIGHTS[c.id] ?? 0), 0);
  const score =
    totalWeight === 0
      ? 0
      : present.reduce((sum, c) => sum + (SURFACE_CHECK_WEIGHTS[c.id] ?? 0) * (c.score as number), 0) / totalWeight;
  return { score: round1(clamp(score, 0, 100)), checks };
}

// ---------------------------------------------------------------------------
// Behavioral sub-scores (from a RunResults file, when provided)
// ---------------------------------------------------------------------------

export interface BehavioralSubScore {
  /** 0-100, normalized for composite averaging. Null when unmeasurable (no run, or the run has no matching cells). */
  score: number | null;
  /** Present only where the natural unit differs from the 0-100 composite score — Lift is a point delta and can be negative. */
  raw?: number;
  note: string;
}

const GUIDED_CONTEXTS = new Set(['agents-md', 'skill', 'mcp']);

function filterAggregates(run: RunResults, system: string | undefined) {
  return system ? run.aggregates.filter((a) => a.system === system) : run.aggregates;
}

function filterRecords(run: RunResults, system: string | undefined) {
  return system ? run.records.filter((r) => r.cell.system === system) : run.records;
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Lift = mean(guided contexts) - mean(bare), across the run's per-cell aggregates — "the fairest cross-system number" because it's a within-model, within-system delta. */
export function computeLift(run: RunResults | undefined, system: string | undefined): BehavioralSubScore {
  if (!run) return { score: null, note: 'TODO: pass --run <dir> to compute Lift from an actual benchmark run.' };
  const aggregates = filterAggregates(run, system);
  const bareMean = mean(aggregates.filter((a) => a.context === 'bare').map((a) => a.meanOverall));
  const guidedMean = mean(aggregates.filter((a) => GUIDED_CONTEXTS.has(a.context)).map((a) => a.meanOverall));
  if (bareMean === undefined || guidedMean === undefined) {
    return { score: null, note: `Run has no aggregates for ${bareMean === undefined ? 'bare' : 'a guided'} context${system ? ` (system: ${system})` : ''}. Lift needs both.` };
  }
  const raw = guidedMean - bareMean;
  // 50 = "guidance had no behavioral effect"; each point of lift/deficit
  // shifts the composite contribution by one point either side, clipped to
  // [0,100]. The raw delta (the actually meaningful number) is reported
  // alongside, never hidden behind the normalization.
  const score = clamp(50 + raw, 0, 100);
  return { score: round1(score), raw: round1(raw), note: `guided mean ${round1(guidedMean)} - bare mean ${round1(bareMean)} = ${raw >= 0 ? '+' : ''}${round1(raw)} points.` };
}

/** Ceiling = "is guided output shippable" — blends guided quality with the guided hard-gate pass rate so a high mean score hiding a high fail rate doesn't read as shippable. */
export function computeCeiling(run: RunResults | undefined, system: string | undefined): BehavioralSubScore {
  if (!run) return { score: null, note: 'TODO: pass --run <dir> to compute Ceiling from an actual benchmark run.' };
  const aggregates = filterAggregates(run, system);
  const guidedMean = mean(aggregates.filter((a) => GUIDED_CONTEXTS.has(a.context)).map((a) => a.meanOverall));
  const guidedOkRecords = filterRecords(run, system).filter((r) => r.status === 'ok' && GUIDED_CONTEXTS.has(r.cell.context));
  if (guidedMean === undefined || guidedOkRecords.length === 0) {
    return { score: null, note: `Run has no ok guided-context cells${system ? ` for system "${system}"` : ''}. Ceiling needs at least one.` };
  }
  const nonFailCount = guidedOkRecords.filter((r) => r.result && r.result.gate !== 'fail').length;
  const nonFailRatePct = (nonFailCount / guidedOkRecords.length) * 100;
  // Equal-weighted blend: quality alone doesn't answer "shippable" if half
  // the outputs hard-fail (hallucinated component / compile error), and the
  // pass rate alone doesn't answer it if what passes is low quality. A
  // documented default, not a derived constant — teams may prefer to weight
  // one side more.
  const score = 0.5 * guidedMean + 0.5 * nonFailRatePct;
  return { score: round1(clamp(score, 0, 100)), note: `guided mean ${round1(guidedMean)}, guided non-fail rate ${round1(nonFailRatePct)}% (${nonFailCount}/${guidedOkRecords.length}).` };
}

const IGNORED_SYSTEM_DIFF = 'no design-system components used';

/** Engagement = 1 - share of ok cells whose diffs include the apiFidelity grader's "ignored the system entirely" marker. */
export function computeEngagement(run: RunResults | undefined, system: string | undefined): BehavioralSubScore {
  if (!run) return { score: null, note: 'TODO: pass --run <dir> to compute Engagement from an actual benchmark run.' };
  const okRecords = filterRecords(run, system).filter((r) => r.status === 'ok' && r.result);
  if (okRecords.length === 0) {
    return { score: null, note: `Run has no ok cells${system ? ` for system "${system}"` : ''}. Engagement needs at least one.` };
  }
  const ignoredCount = okRecords.filter((r) => r.result!.diffs.some((d) => d.message.includes(IGNORED_SYSTEM_DIFF))).length;
  const score = (1 - ignoredCount / okRecords.length) * 100;
  return { score: round1(clamp(score, 0, 100)), note: `${ignoredCount}/${okRecords.length} ok cells ignored the design system entirely.` };
}

const HALLUCINATED_COMPONENT_RE = /^Hallucinated component '([^']+)'/;
const INVENTED_PROP_RE = /^Invented prop '([^']+)'/;

function extractHallucinations(diffs: Diff[]): Array<{ kind: 'component' | 'prop'; name: string }> {
  const out: Array<{ kind: 'component' | 'prop'; name: string }> = [];
  for (const d of diffs) {
    if (d.dimension !== 'apiFidelity') continue;
    const compMatch = HALLUCINATED_COMPONENT_RE.exec(d.message);
    if (compMatch) {
      out.push({ kind: 'component', name: compMatch[1] });
      continue;
    }
    const propMatch = INVENTED_PROP_RE.exec(d.message);
    if (propMatch) out.push({ kind: 'prop', name: propMatch[1] });
  }
  return out;
}

/**
 * Vocabulary-behavioral = how much of the *actual* hallucination mass in
 * this run is attributable to the convention lexicon (a predictable,
 * ecosystem-wide naming gap) vs idiosyncratic invention. Distinct from the
 * static `vocabulary` Tier-0 check, which diffs the catalog against the
 * lexicon with no generations involved — this one diffs real agent output.
 * Low score = agents are hallucinating convention-shaped names a lot (a
 * knowable, fixable gap); a run with zero hallucinations scores 100 (no
 * mass to attribute), which is deliberate — this sub-score measures cost,
 * not raw error count (Ceiling already covers raw failure rate).
 */
export function computeVocabularyBehavioral(run: RunResults | undefined, system: string | undefined): BehavioralSubScore {
  if (!run) return { score: null, note: 'TODO: pass --run <dir> to compute Vocabulary-behavioral from an actual benchmark run.' };
  const okRecords = filterRecords(run, system).filter((r) => r.status === 'ok' && r.result);
  if (okRecords.length === 0) {
    return { score: null, note: `Run has no ok cells${system ? ` for system "${system}"` : ''}. Vocabulary-behavioral needs at least one.` };
  }
  const lexicon = loadLexicon();
  const expectedComponents = new Set(lexicon.components.map((e) => e.expected));
  const expectedProps = new Set(lexicon.props.map((e) => e.expected));

  let total = 0;
  let attributable = 0;
  for (const r of okRecords) {
    for (const h of extractHallucinations(r.result!.diffs)) {
      total += 1;
      const known = h.kind === 'component' ? expectedComponents.has(h.name) : expectedProps.has(h.name);
      if (known) attributable += 1;
    }
  }
  if (total === 0) {
    return { score: 100, note: 'No hallucinated components/invented props in this run. Nothing to attribute.' };
  }
  const score = 100 * (1 - attributable / total);
  return { score: round1(clamp(score, 0, 100)), note: `${attributable}/${total} hallucinated names match a convention-lexicon entry exactly.` };
}

// ---------------------------------------------------------------------------
// Composite + tier
// ---------------------------------------------------------------------------

export type ScoreBasis = 'surface-only' | 'partial-behavioral' | 'full-behavioral';
export type Tier = 'Emerging' | 'Invested' | 'AI-native';

export interface AuditScore {
  surface: SurfaceSubScore;
  lift: BehavioralSubScore;
  ceiling: BehavioralSubScore;
  engagement: BehavioralSubScore;
  vocabularyBehavioral: BehavioralSubScore;
  composite: number;
  basis: ScoreBasis;
  tier: Tier;
  tierRationale: string;
}

/**
 * Tier thresholds. Mirrors the survey's Emerging/Invested/AI-native
 * language, but — per ROADMAP's whole thesis — earned behaviorally rather
 * than by asset checklist:
 *   AI-native >= 70   — strong assets AND (when measured) a real behavioral
 *                       dividend; a system can't reach this on Surface alone
 *                       once a run is available, because full-behavioral
 *                       composite only crosses 70 if Lift/Ceiling/Engagement/
 *                       Vocabulary-behavioral are also strong.
 *   Invested  >= 40   — meaningful investment, incomplete or unproven payoff.
 *   Emerging  <  40   — enablement assets mostly missing, and/or (when
 *                       measured) agents mostly ignore or mishandle the system.
 * These are a documented starting default, not derived from the mined
 * sample — recalibrate once reference runs against OSS systems (P2) give a
 * real distribution to threshold against.
 */
function tierFor(composite: number): { tier: Tier; tierRationale: string } {
  if (composite >= 70) return { tier: 'AI-native', tierRationale: `composite ${round1(composite)} >= 70` };
  if (composite >= 40) return { tier: 'Invested', tierRationale: `composite ${round1(composite)} in [40, 70)` };
  return { tier: 'Emerging', tierRationale: `composite ${round1(composite)} < 40` };
}

/**
 * Assembles the five-number score. With no run: composite = Surface alone,
 * basis 'surface-only' — this is intentionally labeled, not silently
 * presented as the full picture (ROADMAP's whole point is that identical
 * composites can hide opposite failure modes; a surface-only score is
 * itself a distinct, weaker kind of evidence than a behaviorally-grounded
 * one). With a run: equal-weighted mean (20% each) of Surface + the four
 * behavioral sub-scores that are non-null; any still-null behavioral
 * sub-score (e.g. a run with only guided-context cells has no Lift) is
 * excluded and the rest renormalized, basis 'partial-behavioral'.
 */
export function computeAuditScore(checks: AuditCheckResult[], run: RunResults | undefined, system: string | undefined): AuditScore {
  const surface = computeSurfaceScore(checks);
  const lift = computeLift(run, system);
  const ceiling = computeCeiling(run, system);
  const engagement = computeEngagement(run, system);
  const vocabularyBehavioral = computeVocabularyBehavioral(run, system);

  const behavioral = [lift, ceiling, engagement, vocabularyBehavioral].filter((s) => s.score !== null);
  let composite: number;
  let basis: ScoreBasis;
  if (!run || behavioral.length === 0) {
    composite = surface.score;
    basis = 'surface-only';
  } else {
    const scores = [surface.score, ...behavioral.map((s) => s.score as number)];
    composite = scores.reduce((a, b) => a + b, 0) / scores.length;
    basis = behavioral.length === 4 ? 'full-behavioral' : 'partial-behavioral';
  }

  const { tier, tierRationale } = tierFor(composite);
  return { surface, lift, ceiling, engagement, vocabularyBehavioral, composite: round1(composite), basis, tier, tierRationale };
}
