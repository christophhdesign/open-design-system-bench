// The PDF report model: everything a PDF page may print, assembled once
// from ReportStats (the same computed layer the markdown report and
// report.html read). The PDF renderer never does arithmetic of its own:
// any aggregate it needs that stats does not compute yet belongs in
// stats.ts first, so the three surfaces can never disagree and
// `report --validate` can ground prose against the same numbers.

import { rubric } from '../../rubric.config.ts';
import type { RunResults } from '../types.ts';
import { BENCH_VERSION } from '../version.ts';
import { judgeSetup } from './aggregate.ts';
import type { ReportDocument, SectionSlice } from './document.ts';
import { REPORT_OUTLINE } from './stats.ts';
import type { ReportStats } from './stats.ts';
import { fmtDim, fmtOverall } from './stats.ts';
import { fmtMs, fmtUsd } from './shared.ts';

export interface PdfTable {
  headers: string[];
  rows: string[][];
  /** Column indexes (0-based) to right-align and set in mono. */
  numericCols?: number[];
}

export interface PdfSection {
  /** "1", "4.2", "A" - printed in the contents and the heading. */
  number: string;
  title: string;
  level: 1 | 2;
  intro?: string[];
  bullets?: string[];
  tables?: PdfTable[];
  code?: string;
  /** Authored flavor only: markdown prose rendered by the PDF renderer's small markdown subset. */
  authoredMarkdown?: string;
}

export interface PdfScreenshot {
  /** Absolute file path to an existing screenshot.png. The renderer embeds it; it never creates one. */
  path: string;
  caption: string;
}

export interface PdfReportModel {
  flavor: 'instant' | 'authored';
  title: string;
  subtitle: string;
  reportId: string;
  generatedAt: string;
  /** Printed on the cover so an instant PDF is never over-read as an authored one. */
  flavorNote: string;
  coverRows: Array<[string, string]>;
  sections: PdfSection[];
  screenshots: PdfScreenshot[];
}

const DIMENSION_DESCRIPTIONS: Record<string, string> = {
  imports: "Every import source in the diff, against an allowlist: the system's own packages and subpaths, React, the build tool, relative paths, and per-task extras.",
  apiFidelity: 'Every symbol imported from the system exists in the extracted catalog, and every prop passed to a catalogued component is a real prop. A diff that imports nothing from the system scores 0.',
  tokenDiscipline: 'Raw hex colours, rgb()/rgba() calls, and raw px/rem dimensions in className strings and inline style objects.',
  a11yStatic: 'A dependency-free reimplementation of eight eslint-plugin-jsx-a11y rules over a Babel AST pass. control-has-name is the discriminating check.',
  compile: "tsc --noEmit against the generated workspace, type-checking the agent's code against the design system's real types.",
  judgment: 'A separate model evaluates the diff against per-task rubrics authored in the task YAML, each with a weight and an optional critical flag.',
};

function gateCountsText(g: { pass: number; review: number; fail: number }): string {
  return `${g.pass} / ${g.review} / ${g.fail}`;
}

/**
 * Validity limits a single run's shape imposes, stated plainly rather than
 * letting a reader over-read the numbers. This is the floor for the authored
 * flavor: its own validityLimits add to, never replace, these.
 */
export function deriveValidityLimits(stats: ReportStats, run: RunResults): string[] {
  const limits: string[] = [];
  const s = stats.summary;
  const reps = Math.max(1, ...stats.cells.map((c) => c.rep));
  if (reps < 3) {
    limits.push(
      `This run has ${reps} repetition${reps === 1 ? '' : 's'} per cell. Nothing here distinguishes a systematic effect from model variance; three repetitions are the minimum for that.`,
    );
  }
  if (!stats.contexts.includes('bare')) {
    limits.push('The run has no bare context, so Lift is unmeasurable and the AI-Readiness composite is not comparable to one computed with a bare context.');
  }
  const judge = judgeSetup(run.records.filter((r) => r.cell.system === stats.systemId));
  if (judge.missing > 0) {
    limits.push(`${judge.missing} of ${judge.ok} ok cells have no judge verdict, so their overall scores are mechanical-only and run high. See "judge --run <dir> --missing".`);
  }
  if (s.erroredCount > 0) {
    limits.push(`${s.erroredCount} of ${s.cellCount} cells produced no result and are excluded from every mean.`);
  }
  if (run.manifest.paused) {
    limits.push('The run is paused and incomplete. Cells that never ran are not in this report; resume the run before quoting its aggregates.');
  }
  const models = new Set(stats.cells.map((c) => c.model));
  if (models.size === 1 && stats.agents.length === 1) {
    limits.push(`One model (${[...models][0]}), one agent (${stats.agents[0]}). Nothing here generalises to another model or agent.`);
  }
  if (stats.auditScore.basis !== 'full-behavioral') {
    limits.push(`The AI-Readiness composite basis is ${stats.auditScore.basis}: not every behavioral axis could be computed, so the composite is a weaker kind of evidence than a full-behavioral one.`);
  }
  return limits;
}

function headlineTable(stats: ReportStats): PdfTable {
  const s = stats.summary;
  const rows: string[][] = [
    ['Cells graded', `${s.okCount} / ${s.cellCount}`],
    ['Mean overall', fmtOverall(s.meanOverall)],
    ['Median', fmtOverall(s.medianOverall)],
    ['Range', `${fmtOverall(s.minOverall)} - ${fmtOverall(s.maxOverall)}`],
    ['Gates (pass / review / fail)', gateCountsText(s.gateCounts)],
    ['Perfect cells', String(s.perfectCells)],
    ['Mechanical composite', stats.mechanical.composite === null ? 'n/a' : fmtDim(stats.mechanical.composite)],
    ['Mechanically perfect cells', `${stats.mechanical.perfectCells} / ${stats.mechanical.cellCount}`],
    ['AI-Readiness composite', `${fmtDim(stats.auditScore.composite)} (${stats.auditScore.tier}, ${stats.auditScore.basis})`],
    ['Cost', fmtUsd(s.costUsd)],
    ['Wall clock', fmtMs(s.wallClockMs)],
  ];
  if (s.erroredCount > 0) rows.push(['Cells with no result', String(s.erroredCount)]);
  return { headers: ['Metric', 'Value'], rows, numericCols: [1] };
}

function executiveBullets(stats: ReportStats): string[] {
  const s = stats.summary;
  const bullets = [
    `Mean overall ${fmtOverall(s.meanOverall)} across ${s.okCount} graded cells, with gates at ${gateCountsText(s.gateCounts)} (pass / review / fail).`,
    `The mechanical composite is ${stats.mechanical.composite === null ? 'n/a' : fmtDim(stats.mechanical.composite)}, with ${stats.mechanical.perfectCells} of ${stats.mechanical.cellCount} cells perfect on all five mechanical dimensions. It answers "did the agent misuse the system" without depending on a model judge.`,
    `The AI-Readiness composite is ${fmtDim(stats.auditScore.composite)} (${stats.auditScore.tier}, basis ${stats.auditScore.basis}). Read the axes, not only the composite: the results section decomposes it.`,
  ];
  const best = [...stats.byContext].sort((a, b) => b.meanOverall - a.meanOverall)[0];
  const worst = [...stats.byContext].sort((a, b) => a.meanOverall - b.meanOverall)[0];
  if (best && worst && best.context !== worst.context) {
    bullets.push(
      `By context, ${best.context} leads at ${fmtOverall(best.meanOverall)} and ${worst.context} is lowest at ${fmtOverall(worst.meanOverall)}. With the repetition count in this run, treat small context gaps as directional, not settled.`,
    );
  }
  return bullets;
}

/** The instant flavor: everything one finished run can say without an author. */
export function buildInstantPdfModel(
  stats: ReportStats,
  run: RunResults,
  opts?: { generatedAt?: string; screenshots?: PdfScreenshot[] },
): PdfReportModel {
  const generatedAt = opts?.generatedAt ?? new Date().toISOString().slice(0, 10);
  const m = run.manifest;
  const judge = judgeSetup(run.records.filter((r) => r.cell.system === stats.systemId));
  const systemCommit = m.systems[stats.systemId]?.commit;
  const models = [...new Set(stats.cells.map((c) => c.model))].sort();

  const coverRows: Array<[string, string]> = [
    ['System', stats.systemId],
    ['Package', stats.config.componentsPkg],
    ...(systemCommit ? [['System commit', systemCommit.slice(0, 12)] as [string, string]] : []),
    ['Run', `${run.runId}${m.label ? ` (${m.label})` : ''}`],
    ['Profile', m.profile],
    ['Graded cells', `${stats.summary.okCount} / ${stats.summary.cellCount}`],
    ['Task suite', `${stats.taskIds.length} intent-level tasks`],
    ['Contexts', stats.contexts.join(', ')],
    ['Agent / model', `${stats.agents.join(', ')} / ${models.join(', ')}`],
    ['Judge', judge.label === 'none' ? 'none' : `${judge.label} (${judge.judged} of ${judge.ok} ok cells judged)`],
    ['Harness', `open-design-system-bench ${BENCH_VERSION}`],
    ['Report id', `${stats.systemId}-${generatedAt}-${m.profile}`],
    ['Generated', generatedAt],
    ['Cost', fmtUsd(stats.summary.costUsd)],
  ];

  const weights = rubric.weights as Record<string, number>;
  const sections: PdfSection[] = [
    {
      number: '1',
      title: 'Executive summary',
      level: 1,
      intro: ['Every figure in this report is computed from the run. No authored findings are included; the coverage section lists what a written report would still owe.'],
      tables: [headlineTable(stats)],
      bullets: executiveBullets(stats),
    },
    {
      number: '2',
      title: 'Methodology',
      level: 1,
      intro: [
        'The harness issues intent-level task prompts to a headless coding agent inside a disposable fixture workspace that consumes the design system under test. Task prompts never name a component: they describe a user-facing outcome. The generated diff is then graded across six dimensions, five mechanical (deterministic, AST- and compiler-based) and one model-judged.',
        'Each task runs at one or more context levels, which control how much guidance the agent receives. The comparison between context levels is the point of the exercise: it measures how much a given documentation layer actually changes agent behaviour, rather than whether the documentation exists.',
        'Fixture deviations are not recorded by the harness. An authored report states them; this instant report cannot, and does not guess.',
      ],
      tables: [
        {
          headers: ['Context', 'Injected into the workspace'],
          rows: [
            ['bare', 'Nothing. The agent has only the fixture and whatever the fixture exposes.'],
            ['agents-md', 'The files listed in agentContext.agentsMd, copied in as both AGENTS.md and CLAUDE.md.'],
            ['skill', 'Everything from agents-md, plus skill bundles into .claude/skills/ and reference docs into docs/.'],
          ],
        },
        ...(stats.extraction
          ? [{
              headers: ['Extraction', 'Count'],
              rows: [
                ['components', String(stats.extraction.components)],
                ['exports', String(stats.extraction.exports)],
                ['props', String(stats.extraction.props)],
                ['cssVars', String(stats.extraction.cssVars)],
                ['utilities', String(stats.extraction.utilities)],
              ],
              numericCols: [1],
            } as PdfTable]
          : []),
      ],
      code: configurationCode(stats),
    },
    {
      number: '3',
      title: 'What each axis measures',
      level: 1,
      intro: [
        'Six dimensions compose the per-cell score. Overall is the weighted mean, renormalised over the dimensions actually present. The gate is the worst case across dimensions: a single fail fails the cell regardless of how high the weighted mean is.',
        'Separately, the AI-Readiness Score composes five axes. Surface is static and always computable; the other four need a run. Lift needs a bare context specifically. The basis field records which axes could be computed, and composites with different bases are not comparable.',
      ],
      tables: [
        {
          headers: ['Dimension', 'Weight', 'What it checks'],
          rows: stats.dimensionIds.map((dim) => [
            dim,
            weights[dim] !== undefined ? `${(weights[dim] * 100).toFixed(0)}%` : 'n/a',
            DIMENSION_DESCRIPTIONS[dim] ?? 'See the grader source.',
          ]),
          numericCols: [1],
        },
        {
          headers: ['Finding', 'Gate'],
          rows: [
            ['Hallucinated component', 'fail (the headline metric)'],
            ['Compile error', 'fail'],
            ['Two or more foreign UI-library imports', 'fail (exactly one is review)'],
            ['Invented prop', 'review'],
            ['Spread props, unverifiable', 'capped at review'],
            ['More than three token violations', 'review'],
            ['Any static a11y error', 'review'],
            ['Failed critical judge rubric', 'review (the judge alone never fails a run)'],
          ],
        },
      ],
    },
    resultsSection(stats),
    auditSection(stats),
    {
      number: '5',
      title: 'Coverage owed',
      level: 1,
      intro: [
        'An authored report must address every item below, citing the cell, check or dimension it rests on. This instant report addresses none of them: it lists them so the absence of findings is never read as the absence of problems.',
      ],
      tables: [
        {
          headers: ['#', 'Item', 'Status'],
          rows: stats.coverage.length
            ? stats.coverage.map((item, i) => [String(i + 1), item.label, 'unaddressed'])
            : [['-', 'Nothing is mandatory for this run. No hard failures, no low audit checks.', '-']],
          numericCols: [0],
        },
      ],
    },
    operationalSection(stats, run),
    {
      number: '7',
      title: 'Validity limits',
      level: 1,
      bullets: deriveValidityLimits(stats, run),
    },
    {
      number: '8',
      title: 'Recommendations',
      level: 1,
      intro: [
        'None are generated. Recommendations belong to the authored report, where each one links to the findings it comes from. Run the report workflow (report --stats, author the markdown, report --validate) and then render the authored PDF to get them.',
      ],
    },
    {
      number: 'A',
      title: 'Task suite',
      level: 1,
      intro: [`${stats.taskIds.length} intent-level tasks, none naming a component:`],
      bullets: stats.taskIds,
    },
    {
      number: 'B',
      title: 'All cells',
      level: 1,
      tables: [allCellsTable(stats)],
    },
    {
      number: 'C',
      title: 'Reproducing',
      level: 1,
      code: [
        '# the harness lives outside the design system repo',
        'cd open-design-system-bench',
        'npx tsx src/cli.ts doctor',
        'npx tsx src/cli.ts extract',
        `npx tsx src/cli.ts audit --system ${stats.systemId} --run runs/${run.runId}`,
        '',
        '# re-scoring without re-running agents, which costs nothing:',
        `npx tsx src/cli.ts grade --run runs/${run.runId}`,
        '',
        '# regenerating this PDF:',
        `npx tsx src/cli.ts report --pdf --run runs/${run.runId} --system ${stats.systemId}`,
        '',
        'Artefacts per cell: diff.patch, transcript.jsonl, grades.json, judge.json, and the full generated workspace/src.',
      ].join('\n'),
    },
  ];

  return {
    flavor: 'instant',
    title: stats.systemId,
    subtitle: 'AI-readiness benchmark report, generated from one run',
    reportId: `${stats.systemId}-${generatedAt}-${m.profile}`,
    generatedAt,
    flavorNote: 'Instant report: computed from run data only. No authored findings or recommendations.',
    coverRows,
    sections,
    screenshots: opts?.screenshots ?? [],
  };
}

/**
 * The authored flavor: a validated written report rendered to PDF. The
 * document body is the content, section by section in the canonical
 * outline - generated sections arrive as the exact markdown the validator
 * byte-matched, authored sections as the author's prose. The front matter
 * supplies the cover. Nothing is recomputed here.
 */
export function buildAuthoredPdfModel(
  stats: ReportStats,
  run: RunResults,
  doc: ReportDocument,
  slices: Map<string, SectionSlice>,
  opts?: { screenshots?: PdfScreenshot[] },
): PdfReportModel {
  const runsInScope = doc.provenance.runs
    .map((r) => `${r.runId} (${r.role}${r.profile ? `, ${r.profile}` : ''}, ${r.cellCount} cells)`)
    .join('; ');
  const packages = doc.subject.packages
    .map((p) => `${p.name}${p.version ? ` ${p.version}` : ''}`)
    .join(', ');
  const coverRows: Array<[string, string]> = [
    ['System', `${doc.subject.displayName} (${doc.subject.systemId})`],
    ['Packages', packages],
    ...(doc.subject.commit ? [['System commit', doc.subject.commit] as [string, string]] : []),
    ['Runs in scope', runsInScope],
    ['Graded cells', String(doc.results.cellCount ?? stats.summary.cellCount)],
    ['Contexts', doc.methodology.contexts.join(', ')],
    ['Agent / model', `${doc.methodology.agents.join(', ')} / ${doc.methodology.models.join(', ')}`],
    ...(doc.methodology.judge?.model
      ? [['Judge', `${doc.methodology.judge.model}${doc.methodology.judge.samples ? `, ${doc.methodology.judge.samples} sample(s)` : ''}`] as [string, string]]
      : []),
    ['Harness', `open-design-system-bench ${doc.harness.version}`],
    ['Author', doc.author.model ? `${doc.author.kind} (${doc.author.model})` : doc.author.kind],
    ['Report id', doc.reportId],
    ['Generated', doc.generatedAt],
    ['Comparability key', doc.methodology.comparabilityKey],
  ];

  const sections: PdfSection[] = [];
  for (const outline of REPORT_OUTLINE) {
    const slice = slices.get(outline.number);
    if (!slice) continue;
    sections.push({
      number: outline.number,
      title: outline.title,
      level: outline.level === 3 ? 2 : 1,
      authoredMarkdown: slice.content,
    });
    if (outline.number === '2.3' && doc.provenance.runs.length > 1) {
      sections.push({
        number: '2.5',
        title: 'Runs in scope',
        level: 2,
        tables: [{
          headers: ['Run', 'Profile', 'Role', 'Cells'],
          rows: doc.provenance.runs.map((r) => [r.runId, r.profile, r.role, String(r.cellCount)]),
          numericCols: [3],
        }],
      });
    }
  }

  return {
    flavor: 'authored',
    title: doc.subject.displayName,
    subtitle: doc.title,
    reportId: doc.reportId,
    generatedAt: doc.generatedAt,
    flavorNote: 'Authored report: validated written report rendered to PDF.',
    coverRows,
    sections,
    screenshots: opts?.screenshots ?? [],
  };
}

function configurationCode(stats: ReportStats): string {
  // Same redaction as the markdown report: the checkout path is the
  // operator's directory tree, not part of the measurement.
  const { root, rootEnv, ...rest } = stats.config;
  void root;
  void rootEnv;
  return JSON.stringify({ root: '<system checkout>', ...rest }, null, 2);
}

function resultsSection(stats: ReportStats): PdfSection {
  const dims = stats.dimensionIds;
  const byContext: PdfTable = {
    headers: ['Context', ...dims, 'Mean', 'Gates (p/r/f)'],
    rows: stats.byContext.map((c) => [
      c.context,
      ...dims.map((d) => (typeof c.dimensionMeans[d] === 'number' ? fmtDim(c.dimensionMeans[d]) : 'n/a')),
      fmtOverall(c.meanOverall),
      gateCountsText(c.gateCounts),
    ]),
    numericCols: dims.map((_, i) => i + 1).concat([dims.length + 1]),
  };

  // By task and context: one row per task, one column per context (per model
  // when the run carries more than one).
  const models = [...new Set(stats.byTaskContext.map((t) => t.model))].sort();
  const contexts = stats.contexts;
  const colKeys = contexts.flatMap((context) => models.map((model) => ({ context, model })));
  const byTask: PdfTable = {
    headers: ['Task', ...colKeys.map((k) => (models.length > 1 ? `${k.context} / ${k.model}` : k.context))],
    rows: stats.taskIds.map((taskId) => [
      taskId,
      ...colKeys.map((k) => {
        const hit = stats.byTaskContext.find((t) => t.taskId === taskId && t.context === k.context && t.model === k.model);
        return hit ? fmtOverall(hit.meanOverall) : '-';
      }),
    ]),
    numericCols: colKeys.map((_, i) => i + 1),
  };

  const byTaskAll: PdfTable = {
    headers: ['Task', 'Mean', 'Cells', 'Gates (p/r/f)'],
    rows: stats.taskIds.map((taskId) => {
      const cells = stats.cells.filter((c) => c.taskId === taskId && c.overall !== null);
      const gates = { pass: 0, review: 0, fail: 0 };
      for (const c of cells) if (c.gate) gates[c.gate] += 1;
      const mean = cells.length ? cells.reduce((sum, c) => sum + (c.overall as number), 0) / cells.length : null;
      return [taskId, mean === null ? 'n/a' : fmtOverall(mean), String(cells.length), gateCountsText(gates)];
    }),
    numericCols: [1, 2],
  };

  const mechanical: PdfTable = {
    headers: ['Context', 'Mechanical composite', 'Mechanically perfect', 'Cells'],
    rows: [
      ...stats.mechanicalByContext.map((mc) => [
        mc.context,
        mc.composite === null ? 'n/a' : fmtDim(mc.composite),
        String(mc.perfectCells),
        String(mc.cellCount),
      ]),
      ['all', stats.mechanical.composite === null ? 'n/a' : fmtDim(stats.mechanical.composite), String(stats.mechanical.perfectCells), String(stats.mechanical.cellCount)],
    ],
    numericCols: [1, 2, 3],
  };

  return {
    number: '4',
    title: 'Results',
    level: 1,
    intro: [`Weights: ${dims.map((d) => `${d} ${((rubric.weights as Record<string, number>)[d] ?? 0) * 100}%`).join(' / ')}.`],
    tables: [byContext, byTask, byTaskAll, mechanical],
  };
}

function auditSection(stats: ReportStats): PdfSection {
  const a = stats.auditScore;
  const axis = (label: string, sub: { score: number | null; raw?: number; note: string }): string[] => [
    label,
    sub.score === null ? 'n/a' : fmtDim(sub.score),
    sub.raw !== undefined ? fmtDim(sub.raw) : '',
    sub.note,
  ];
  return {
    number: '4.5',
    title: 'AI-Readiness audit',
    level: 2,
    tables: [
      {
        headers: ['Axis', 'Score', 'Raw', 'How it was computed'],
        rows: [
          axis('Surface', { score: a.surface.score, note: 'weighted mean of the seven static checks' }),
          axis('Lift', a.lift),
          axis('Ceiling', a.ceiling),
          axis('Engagement', a.engagement),
          axis('Vocabulary, behavioural', a.vocabularyBehavioral),
          ['Composite', fmtDim(a.composite), '', `${a.tier} (basis: ${a.basis})`],
        ],
        numericCols: [1, 2],
      },
      {
        headers: ['Surface check', 'Score'],
        rows: stats.auditChecks.map((c) => [c.title, c.score === null ? 'n/a (unmeasured)' : fmtDim(c.score)]),
        numericCols: [1],
      },
    ],
  };
}

function operationalSection(stats: ReportStats, run: RunResults): PdfSection {
  const nonOk = run.records.filter((r) => r.cell.system === stats.systemId && r.status !== 'ok');
  const judge = judgeSetup(run.records.filter((r) => r.cell.system === stats.systemId));
  const bullets: string[] = [];
  if (judge.missing > 0) bullets.push(`${judge.missing} ok cell(s) have no judge verdict. Fill them with: npx tsx src/cli.ts judge --run runs/${run.runId} --missing`);
  if (run.manifest.paused) bullets.push('The run finished paused. Resume it before treating any aggregate as final.');
  return {
    number: '6',
    title: 'Operational summary',
    level: 1,
    intro: ['Cells that produced no result, and judging gaps. A benchmark that never reports its own failures is not reporting honestly, so this section stays even when it is empty.'],
    bullets: bullets.length ? bullets : ['No operational problems recorded for this run.'],
    tables: nonOk.length
      ? [{
          headers: ['Task', 'Context', 'Rep', 'Status', 'Reason'],
          rows: nonOk.map((r) => [r.taskId, r.cell.context, String(r.rep), r.status, r.skipReason ?? '']),
          numericCols: [2],
        }]
      : [],
  };
}

function allCellsTable(stats: ReportStats): PdfTable {
  const dims = stats.dimensionIds;
  return {
    headers: ['#', 'Task', 'Context', ...dims, 'Overall', 'Gate'],
    rows: stats.cells.map((c) => {
      if (c.overall === null) {
        return [String(c.index), c.taskId, c.context, ...dims.map(() => '-'), '-', c.status];
      }
      return [
        String(c.index),
        c.taskId,
        c.context,
        ...dims.map((d) => (typeof c.dimensions[d] === 'number' ? fmtDim(c.dimensions[d]) : '-')),
        fmtOverall(c.overall),
        c.gate ?? '',
      ];
    }),
    numericCols: dims.map((_, i) => i + 3).concat([dims.length + 3]),
  };
}
