// AI-readiness leaderboard: merges N `audit --json` files into one
// self-contained page ranking systems by their audit composite. Same
// inline-everything house style as html.ts / compare.ts (shared.ts scaffold).
//
// Honesty rule inherited from the audit itself: a surface-only composite is a
// weaker kind of evidence than a behaviorally-grounded one (see
// computeAuditScore in src/audit/score.ts). Rows are ranked by composite but
// every row carries its basis label, and the lede says so out loud rather
// than letting mixed-evidence rows read as one homogeneous ranking.

import type { AuditScore } from '../audit/score.ts';
import type { AuditCheckResult } from '../audit/types.ts';
import { esc, fmtScore, jsonScript, page, scoreTone } from './shared.ts';

/** Shape of one `audit --json` output file (assembled in src/cli.ts cmdAudit). */
export interface AuditReportFile {
  systemsConfigPath: string;
  run: string | null;
  systems: Record<string, { checks: AuditCheckResult[]; score: AuditScore }>;
}

export interface LeaderboardEntry {
  system: string;
  /** The audit JSON file this entry came from (for provenance in the page footer). */
  source: string;
  checks: AuditCheckResult[];
  score: AuditScore;
}

/** Canonical column order matches SURFACE_CHECK_WEIGHTS in src/audit/score.ts; unknown ids (future checks) are appended after. */
const CHECK_ORDER = [
  'surface',
  'catalog-quality',
  'export-hygiene',
  'vocabulary',
  'tokens',
  'deprecation',
  'docs-greppability',
];

/**
 * Flattens audit files into leaderboard entries. A system id appearing in two
 * files is refused rather than silently last-wins — two audits of the same id
 * are two snapshots, and picking one for a published ranking is the caller's
 * decision, not this module's.
 */
export function collectLeaderboardEntries(files: { path: string; report: AuditReportFile }[]): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = [];
  const seen = new Map<string, string>();
  for (const { path, report } of files) {
    if (!report || typeof report !== 'object' || !report.systems || typeof report.systems !== 'object') {
      throw new Error(`${path} is not an \`audit --json\` output file (no "systems" object)`);
    }
    for (const [system, data] of Object.entries(report.systems)) {
      const prior = seen.get(system);
      if (prior) {
        throw new Error(`system "${system}" appears in both ${prior} and ${path} — pass one audit file per system snapshot`);
      }
      seen.set(system, path);
      entries.push({ system, source: path, checks: data.checks, score: data.score });
    }
  }
  return entries;
}

/** Composite desc, alphabetical on ties, so the ranking is deterministic. */
export function rankEntries(entries: LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    if (b.score.composite !== a.score.composite) return b.score.composite - a.score.composite;
    return a.system < b.system ? -1 : a.system > b.system ? 1 : 0;
  });
}

const TIER_CHIP_CLASS: Record<string, string> = {
  'AI-native': 'chip-pass',
  Invested: 'chip-review',
  Emerging: 'chip-fail',
};

function tierChip(tier: string): string {
  return `<span class="chip ${TIER_CHIP_CLASS[tier] ?? 'chip-skip'}">${esc(tier)}</span>`;
}

const NA_CELL = '<td class="num"><span class="na">n/a</span></td>';

function scoreCell(score: number | null | undefined): string {
  if (score == null || Number.isNaN(score)) return NA_CELL;
  return `<td class="num tone-${scoreTone(score)}"><span class="lb-score">${fmtScore(score)}</span></td>`;
}

/** Lift's natural unit is a signed point delta (score is the 0-100 normalization); show the raw delta when present. */
function liftCell(score: AuditScore): string {
  if (score.lift.score == null) return NA_CELL;
  if (score.lift.raw == null) return scoreCell(score.lift.score);
  const sign = score.lift.raw > 0 ? '+' : '';
  const cls = score.lift.raw > 0 ? 'delta-up' : score.lift.raw < 0 ? 'delta-down' : 'delta-flat';
  return `<td class="num"><span class="${cls}">${sign}${score.lift.raw.toFixed(1)}</span></td>`;
}

function checkColumns(entries: LeaderboardEntry[]): string[] {
  const known = new Set(CHECK_ORDER);
  const extras: string[] = [];
  for (const e of entries) {
    for (const c of e.checks) {
      if (!known.has(c.id) && !extras.includes(c.id)) extras.push(c.id);
    }
  }
  return [...CHECK_ORDER, ...extras];
}

function renderRankingTable(ranked: LeaderboardEntry[]): string {
  const rows = ranked
    .map((e, i) => {
      const s = e.score;
      return `<tr>
<td class="num">${i + 1}</td>
<td class="mono">${esc(e.system)}</td>
<td>${tierChip(s.tier)}</td>
${scoreCell(s.composite)}
<td class="mono lb-basis">${esc(s.basis)}</td>
${scoreCell(s.surface.score)}
${liftCell(s)}
${scoreCell(s.ceiling.score)}
${scoreCell(s.engagement.score)}
${scoreCell(s.vocabularyBehavioral.score)}
</tr>`;
    })
    .join('\n');

  return `<section>
<h2>Ranking</h2>
<p class="lede">Ranked by audit composite. "surface-only" rows are scored from static checks alone; behavioral columns (Lift, Ceiling, Engagement, Vocabulary) need a benchmark run and report n/a until one is provided via \`audit --run\`. A surface-only composite and a behavioral composite are different kinds of evidence; the basis column keeps them distinguishable.</p>
<div class="card"><div class="scroll-x"><table>
<thead><tr><th>#</th><th>System</th><th>Tier</th><th>Composite</th><th>Basis</th><th>Surface</th><th>Lift</th><th>Ceiling</th><th>Engagement</th><th>Vocabulary</th></tr></thead>
<tbody>${rows}</tbody>
</table></div></div>
</section>`;
}

function renderCheckTable(ranked: LeaderboardEntry[]): string {
  const cols = checkColumns(ranked);
  const titles = new Map<string, string>();
  for (const e of ranked) for (const c of e.checks) titles.set(c.id, c.title);

  const header = cols.map((id) => `<th title="${esc(titles.get(id) ?? id)}">${esc(id)}</th>`).join('');
  const rows = ranked
    .map((e) => {
      const byId = new Map(e.checks.map((c) => [c.id, c]));
      const cells = cols.map((id) => scoreCell(byId.get(id)?.score ?? null)).join('');
      return `<tr><td class="mono">${esc(e.system)}</td>${cells}</tr>`;
    })
    .join('\n');

  return `<section>
<h2>Static checks</h2>
<p class="lede">The seven Tier-0 checks behind the Surface sub-score. n/a means the check could not run for that system (for example no extracted catalog), and its weight was redistributed rather than counted as zero.</p>
<div class="card"><div class="scroll-x"><table>
<thead><tr><th>System</th>${header}</tr></thead>
<tbody>${rows}</tbody>
</table></div></div>
</section>`;
}

function renderFindings(ranked: LeaderboardEntry[]): string {
  const cards = ranked
    .map((e) => {
      const items = e.checks
        .flatMap((c) => c.findings.filter((f) => f.severity !== 'info').map((f) => ({ check: c.id, ...f })))
        .map(
          (f) =>
            `<li><span class="chip ${f.severity === 'fail' ? 'chip-fail' : 'chip-review'}">${esc(f.severity)}</span> <span class="mono lb-check">${esc(f.check)}</span> ${esc(f.message)}${f.fix ? ` <span class="lb-fix">fix: ${esc(f.fix)}</span>` : ''}</li>`,
        );
      if (items.length === 0) return '';
      return `<div class="card"><h3>${esc(e.system)} ${tierChip(e.score.tier)}</h3><div class="body"><ul class="lb-findings">${items.join('\n')}</ul></div></div>`;
    })
    .filter(Boolean)
    .join('\n');

  if (!cards) return '';
  return `<section>
<h2>What to fix</h2>
<p class="lede">Warn and fail findings from the static checks, per system. These are the concrete gaps behind the scores above.</p>
${cards}
</section>`;
}

const LEADERBOARD_CSS = `
.lb-score{font-weight:700}
td.tone-green .lb-score{color:var(--green)}
td.tone-yellow .lb-score{color:var(--yellow)}
td.tone-red .lb-score{color:var(--red)}
.lb-basis{font-size:11px;color:var(--muted)}
.lb-findings{margin:0;padding-left:0;list-style:none;display:flex;flex-direction:column;gap:8px}
.lb-findings li{white-space:normal}
.lb-check{color:var(--accent-ink);font-size:12px}
.lb-fix{color:var(--muted)}
`;

export function renderLeaderboardHtml(entries: LeaderboardEntry[], opts?: { generatedAt?: string }): string {
  const ranked = rankEntries(entries);
  const generatedAt = opts?.generatedAt ?? new Date().toISOString();
  const sources = [...new Set(ranked.map((e) => e.source))];
  const bases = new Set(ranked.map((e) => e.score.basis));

  const header = `<header class="top">
<h1>AI-readiness leaderboard</h1>
<div class="meta-grid">
<div class="meta-item"><div class="label">Systems</div><div class="value">${ranked.length}</div></div>
<div class="meta-item"><div class="label">Audit files</div><div class="value">${sources.length}</div></div>
<div class="meta-item"><div class="label">Evidence basis</div><div class="value">${esc([...bases].join(', ') || 'n/a')}</div></div>
<div class="meta-item"><div class="label">Generated</div><div class="value">${esc(generatedAt)}</div></div>
</div>
</header>`;

  const footer = `<footer class="foot">Generated by open-ds-bench \`leaderboard\` from: ${sources.map((s) => esc(s)).join(' · ')}. Tier thresholds (AI-native &ge;70, Invested &ge;40) are documented defaults pending recalibration from reference-run distributions.</footer>`;

  const body = `<style>${LEADERBOARD_CSS}</style>
<div class="wrap">
${header}
${renderRankingTable(ranked)}
${renderCheckTable(ranked)}
${renderFindings(ranked)}
${footer}
</div>
${jsonScript('leaderboard-data', { generatedAt, entries: ranked })}`;

  return page('AI-readiness leaderboard', body, '');
}
