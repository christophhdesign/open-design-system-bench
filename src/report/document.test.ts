// Full-gate validation of docs/reports/report-example.md against the committed
// run, plus one negative case per gate.
//
// The example is generated from src/report/__fixtures__/example-run.json by
// construction, so these tests double as a drift alarm: if a generated block's
// rendering changes and the example is not regenerated, the G3 test fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import { computeAuditScore } from '../audit/score.ts';
import { paths } from '../config.ts';
import { buildRunResults } from './aggregate.ts';
import {
  loadReportSchema,
  parseReportFrontMatter,
  scanProseNumbers,
  splitSections,
  validateReport,
  type ValidateContext,
} from './document.ts';
import { buildGeneratedFrontMatter, buildReportStats } from './stats.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const EXAMPLE = join(REPO_ROOT, 'docs', 'reports', 'report-example.md');

function fixtureContext(): ValidateContext {
  const fx = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'example-run.json'), 'utf8'));
  const run = buildRunResults(fx.manifest, fx.records);
  const score = computeAuditScore(fx.checks, run, 'my-system');
  const stats = buildReportStats(run, 'my-system', fx.config, fx.checks, score, fx.extraction);
  return { stats, run, generatedFrontMatter: buildGeneratedFrontMatter(stats, run) };
}

function validate(markdown: string) {
  return validateReport({
    filename: 'report-example.md',
    markdown,
    schema: loadReportSchema(paths.reportSchema),
    context: fixtureContext(),
    sourceRoots: [REPO_ROOT],
  });
}

/**
 * Normalized to LF. On a checkout with core.autocrlf=true the file arrives with
 * CRLF, which parseReportFrontMatter handles but which would silently break the
 * literal string edits the negative cases below rely on.
 */
function example(): string {
  return readFileSync(EXAMPLE, 'utf8').replace(/\r\n/g, '\n');
}

/** Rewrites the YAML front matter, leaving the prose body untouched. */
function withFrontMatter(markdown: string, mutate: (fm: Record<string, unknown>) => void): string {
  const parsed = parseReportFrontMatter(markdown, 'test');
  const fm = parsed.frontMatter as Record<string, unknown>;
  mutate(fm);
  return `---\n${dump(fm, { lineWidth: 100, noRefs: true }).trimEnd()}\n---\n${parsed.body}`;
}

function gates(result: { errors: Array<{ gate: string }> }): string[] {
  return [...new Set(result.errors.map((e) => e.gate))];
}

// ---------------------------------------------------------------------------

test('the shipped example passes every gate against its fixture run', () => {
  const result = validate(example());
  assert.deepEqual(
    result.errors.map((e) => `${e.gate}: ${e.message}`),
    [],
  );
  assert.equal(result.degraded, false);
});

test('the example warns only about the un-checked-out system repo', () => {
  const result = validate(example());
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].gate, /G5/);
});

test('G1: a front matter that violates the schema stops validation there', () => {
  const broken = withFrontMatter(example(), (fm) => {
    (fm.findings as Array<Record<string, unknown>>)[0].severity = 'catastrophic';
  });
  const result = validate(broken);
  assert.deepEqual(gates(result), ['G1 schema']);
  assert.match(result.errors[0].message, /findings\[0\]\.severity/);
});

test('G1: front matter is required', () => {
  assert.throws(() => validate('# A report with no front matter\n'), /no YAML front matter/);
});

test('G2: renaming a mandatory heading fails', () => {
  const renamed = example().replace('## 6. Notable individual results', '## 6. Interesting bits');
  const result = validate(renamed);
  assert.ok(gates(result).includes('G2 outline'));
  assert.ok(result.errors.some((e) => /Notable individual results/.test(e.message)));
});

test('G2: reordering mandatory headings fails', () => {
  const md = example();
  const seven = md.indexOf('## 7. Harness defects');
  const eight = md.indexOf('## 8. Validity limits');
  const nine = md.indexOf('## 9. Recommendations');
  const reordered = md.slice(0, seven) + md.slice(eight, nine) + md.slice(seven, eight) + md.slice(nine);
  const result = validate(reordered);
  assert.ok(gates(result).includes('G2 outline'));
});

test('G3: changing one digit inside a generated table fails', () => {
  // The executive summary's median, edited by hand rather than regenerated.
  const tampered = example().replace('| Median | 90.25 |', '| Median | 94.90 |');
  assert.notEqual(tampered, example());
  const result = validate(tampered);
  assert.ok(gates(result).includes('G3 generated'));
  assert.ok(result.errors.some((e) => /First difference at line/.test(e.message)));
});

test('G3: a generated section may not carry sub-headings', () => {
  const tampered = example().replace(
    '## 1. Executive summary\n',
    '## 1. Executive summary\n\n### 1.1 A heading that does not belong\n',
  );
  const result = validate(tampered);
  assert.ok(result.errors.some((e) => e.gate === 'G3 generated' && /must not contain sub-headings/.test(e.message)));
});

test('G4: an invented number in agent prose fails', () => {
  const tampered = example().replace(
    'scored 35.0, the lowest of the seven static checks',
    'scored 35.0, the lowest of the seven static checks, down from 61.4 last quarter',
  );
  const result = validate(tampered);
  assert.ok(gates(result).includes('G4 numbers'));
  assert.ok(result.errors.some((e) => /61\.4/.test(e.message)));
});

test('G4: a number inside a code fence is quoted output, not a claim', () => {
  const tampered = example().replace(
    '### 5.1 No AGENTS.md at the system root\n',
    '### 5.1 No AGENTS.md at the system root\n\n```\nsome tool output: 61.4\n```\n',
  );
  const result = validate(tampered);
  assert.ok(!gates(tampered ? result : result).includes('G4 numbers'));
});

test('G4: a declared citedFigure makes its number quotable', () => {
  const withFigure = withFrontMatter(
    example().replace('that the build step resolves', 'that the build step resolves, 47 of them in one file,'),
    (fm) => {
      (fm.citedFigures as unknown[]).push({
        id: 'elevation-references',
        value: 47,
        source: 'packages/tokens/src/elevations.json',
        method: 'count of values referencing another token by name',
      });
    },
  );
  const result = validate(withFigure);
  assert.ok(!gates(result).includes('G4 numbers'));
});

test('G6: duplicate finding ids fail', () => {
  const dup = withFrontMatter(example(), (fm) => {
    const findings = fm.findings as Array<Record<string, unknown>>;
    findings[1].id = findings[0].id;
  });
  const result = validate(dup);
  assert.ok(result.errors.some((e) => e.gate === 'G6 ids' && /duplicate finding id/.test(e.message)));
});

test('G8: a recommendation pointing at an unknown finding fails', () => {
  const broken = withFrontMatter(example(), (fm) => {
    (fm.recommendations as Array<Record<string, unknown>>)[0].findingIds = ['no-such-finding'];
  });
  const result = validate(broken);
  assert.ok(result.errors.some((e) => e.gate === 'G8 refs' && /unknown finding/.test(e.message)));
});

test('G9: evidence pointing at a task the run does not contain fails', () => {
  const broken = withFrontMatter(example(), (fm) => {
    const findings = fm.findings as Array<{ id: string; evidence: Array<Record<string, unknown>> }>;
    const target = findings.find((f) => f.id === 'skill-bypasses-pagination');
    assert.ok(target);
    target.evidence[0].taskId = 'a-task-that-never-ran';
  });
  const result = validate(broken);
  assert.ok(result.errors.some((e) => e.gate === 'G9 evidence' && /a-task-that-never-ran/.test(e.message)));
});

test('G9: evidence citing a dimension the cell has no score for fails', () => {
  const broken = withFrontMatter(example(), (fm) => {
    const findings = fm.findings as Array<{ id: string; evidence: Array<Record<string, unknown>> }>;
    const target = findings.find((f) => f.id === 'skill-bypasses-pagination');
    assert.ok(target);
    target.evidence[0].dimension = 'notADimension';
  });
  const result = validate(broken);
  assert.ok(result.errors.some((e) => e.gate === 'G9 evidence' && /notADimension/.test(e.message)));
});

test('G9: an unknown audit check id fails', () => {
  const broken = withFrontMatter(example(), (fm) => {
    const findings = fm.findings as Array<{ id: string; evidence: Array<Record<string, unknown>> }>;
    const target = findings.find((f) => f.id === 'no-agents-md');
    assert.ok(target);
    target.evidence[0].checkId = 'not-a-check';
  });
  const result = validate(broken);
  assert.ok(result.errors.some((e) => e.gate === 'G9 evidence' && /not-a-check/.test(e.message)));
});

test('G10: dropping the finding that covers the hard failure fails', () => {
  const stripped = withFrontMatter(example(), (fm) => {
    fm.findings = (fm.findings as Array<{ id: string }>).filter((f) => f.id !== 'skill-bypasses-pagination');
    fm.recommendations = (fm.recommendations as Array<{ findingIds: string[] }>).filter(
      (r) => !r.findingIds.includes('skill-bypasses-pagination'),
    );
  });
  const result = validate(stripped);
  assert.ok(result.errors.some((e) => e.gate === 'G10 coverage' && /hard failure/.test(e.message)));
});

test('G10: dropping the finding that covers a low audit check fails', () => {
  const stripped = withFrontMatter(example(), (fm) => {
    fm.findings = (fm.findings as Array<{ id: string }>).filter((f) => f.id !== 'no-agents-md');
    fm.recommendations = (fm.recommendations as Array<{ findingIds: string[] }>).filter(
      (r) => !r.findingIds.includes('no-agents-md'),
    );
  });
  const result = validate(stripped);
  assert.ok(result.errors.some((e) => e.gate === 'G10 coverage' && /Enablement surface/.test(e.message)));
});

test('G11: an unresolved needs-triage finding fails', () => {
  const triage = withFrontMatter(example(), (fm) => {
    (fm.findings as Array<Record<string, unknown>>)[0].status = 'needs-triage';
  });
  const result = validate(triage);
  assert.ok(result.errors.some((e) => e.gate === 'G11 triage'));
});

test('G12: a finding dropped since the previous report warns rather than fails', () => {
  const result = validateReport({
    filename: 'report-example.md',
    markdown: example(),
    schema: loadReportSchema(paths.reportSchema),
    context: fixtureContext(),
    sourceRoots: [REPO_ROOT],
    prior: [{ id: 'some-older-defect', title: 'Fixed last quarter', severity: 'defect', status: 'confirmed' }],
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((w) => w.gate === 'G12 history' && /some-older-defect/.test(w.message)));
});

test('G14: em dashes and curly quotes warn but do not fail', () => {
  const styled = example().replace('Five findings.', 'Five findings — all of them “real”.');
  const result = validate(styled);
  assert.deepEqual(gates(result), []);
  assert.ok(result.warnings.some((w) => w.gate === 'G14 style' && /em dashes/.test(w.message)));
  assert.ok(result.warnings.some((w) => w.gate === 'G14 style' && /curly quotes/.test(w.message)));
});

test('a report outlives its run: no context degrades data gates to a warning', () => {
  const result = validateReport({
    filename: 'report-example.md',
    markdown: example(),
    schema: loadReportSchema(paths.reportSchema),
    context: null,
    sourceRoots: [REPO_ROOT],
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.degraded, true);
  assert.ok(result.warnings.some((w) => /structural validation only/i.test(w.message)));
});

// --- unit-level -------------------------------------------------------------

test('splitSections gives agent sections their sub-headings and generated ones none', () => {
  const { slices, missing, outOfOrder } = splitSections(parseReportFrontMatter(example(), 'x').body);
  assert.deepEqual(missing, []);
  assert.deepEqual(outOfOrder, []);
  assert.deepEqual(slices.get('1')?.extraHeadings, []);
  assert.ok((slices.get('5')?.extraHeadings ?? []).some((h) => h.startsWith('5.1')));
});

test('scanProseNumbers ignores navigation and quoted output, and catches claims', () => {
  const hits = scanProseNumbers(
    [
      '### 5.1 A heading with a number',
      'See section 4.2 and also 5.1 for context.',
      'The version is 2.4.0, released 2026-01-01, commit abc1234f.',
      'Inline `47` code and a [link](https://example.com/9000).',
      '```',
      'tool output: 1234',
      '```',
      'The mean was 92.49 across the run.',
    ].join('\n'),
    1,
    new Set(['4.2', '5.1']),
  );
  assert.deepEqual(
    hits.map((h) => h.value),
    [92.49],
  );
});

test('scanProseNumbers treats a dotted number as a claim unless it is a real section', () => {
  const hits = scanProseNumbers('It scored 5.1 on that axis.', 1, new Set(['4.2']));
  assert.deepEqual(
    hits.map((h) => h.value),
    [5.1],
  );
});

test('scanProseNumbers ignores ordered-list markers', () => {
  // Recommendations and validity limits are numbered lists, so every report has
  // these. Reading "4." as a claim made the gate fire on its own formatting.
  const hits = scanProseNumbers(
    ['1. First item.', '2. Second item.', '  10) A nested item.', '4. Scored 64.1 on that check.'].join('\n'),
    1,
  );
  assert.deepEqual(
    hits.map((h) => h.value),
    [64.1],
  );
});

test('scanProseNumbers reads thousands separators as one number', () => {
  const hits = scanProseNumbers('It produced 1,234 lines.', 1);
  assert.deepEqual(
    hits.map((h) => h.value),
    [1234],
  );
});
