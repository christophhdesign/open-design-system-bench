// PDF reports: the model, the print renderer and the Chrome printing step.
// Offline by construction - printing is tested against a fake Chrome shell
// script, never a real browser or a live run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAuditScore } from '../audit/score.ts';
import { buildRunResults } from './aggregate.ts';
import { buildReportStats, type ReportStats } from './stats.ts';
import { buildAuthoredPdfModel, buildInstantPdfModel, deriveValidityLimits } from './pdf-model.ts';
import { collectExistingScreenshots, printPdfHtml, renderMarkdown, renderPdfHtml } from './pdf.ts';
import { parseReportFrontMatter, splitSections, type ReportDocument } from './document.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

function fixture() {
  const fx = JSON.parse(readFileSync(join(HERE, '__fixtures__', 'example-run.json'), 'utf8'));
  const run = buildRunResults(fx.manifest, fx.records);
  const score = computeAuditScore(fx.checks, run, 'my-system');
  const stats: ReportStats = buildReportStats(run, 'my-system', fx.config, fx.checks, score, fx.extraction);
  return { fx, run, stats };
}

test('instant model is labeled as data-only and carries the computed headline', () => {
  const { run, stats } = fixture();
  const model = buildInstantPdfModel(stats, run, { generatedAt: '2026-01-02' });

  assert.equal(model.flavor, 'instant');
  assert.match(model.flavorNote, /No authored findings/);
  assert.equal(model.reportId, 'my-system-2026-01-02-medium');
  const cover = Object.fromEntries(model.coverRows);
  assert.equal(cover['Harness'], 'open-design-system-bench v1.5');
  assert.equal(cover['System'], 'my-system');
  assert.equal(cover['Graded cells'], `${stats.summary.okCount} / ${stats.summary.cellCount}`);

  const exec = model.sections.find((s) => s.number === '1');
  const headline = exec?.tables?.[0];
  const mechanicalRow = headline?.rows.find((r) => r[0] === 'Mechanical composite');
  assert.equal(mechanicalRow?.[1], stats.mechanical.composite?.toFixed(1));

  // The coverage owed is printed, marked unaddressed, never silently dropped.
  const coverage = model.sections.find((s) => s.number === '5');
  assert.ok(coverage);
  if (stats.coverage.length > 0) {
    assert.ok(coverage.tables?.[0].rows.every((r) => r[2] === 'unaddressed'));
  }
});

test('validity limits are derived from the run shape, not asserted', () => {
  const { run, stats } = fixture();
  const limits = deriveValidityLimits(stats, run);
  // The example run has no bare context and a single model: both must surface.
  assert.ok(limits.some((l) => l.includes('no bare context')));
  assert.ok(limits.some((l) => l.includes('One model')));
});

test('print HTML is a self-contained A4 document with cover, contents and all cells', () => {
  const { run, stats } = fixture();
  const html = renderPdfHtml(buildInstantPdfModel(stats, run, { generatedAt: '2026-01-02' }));

  assert.match(html, /@page \{ size: A4/);
  // The print stylesheet is the light twin of the screen tokens in shared.ts.
  assert.match(html, /--accent: #1e40af/);
  assert.match(html, /print-color-adjust: exact/);
  assert.match(html, /AI-readiness benchmark report/);
  assert.match(html, /Contents/);
  assert.match(html, /Coverage owed/);
  assert.match(html, /All cells/);
  // No external resources: the document must print offline and archive safely.
  assert.doesNotMatch(html, /<link|<script|src="http/);
  // One row per graded cell in the appendix (plus the header row).
  assert.equal((html.match(/<tr>/g) ?? []).length > stats.summary.cellCount, true);
});

test('renderMarkdown covers the authored subset: headings, tables, lists, code, emphasis', () => {
  const html = renderMarkdown(
    [
      '### 5.1 A finding',
      '',
      'Prose with **bold**, `code` and a [link](https://example.com).',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '- one',
      '- two',
      '',
      '```',
      'const x = 1 < 2;',
      '```',
    ].join('\n'),
  );
  assert.match(html, /<h3>5\.1 A finding<\/h3>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /const x = 1 &lt; 2;/);
});

test('printPdfHtml prints through a Chrome binary and degrades without one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsb-pdf-test-'));
  const pdfPath = join(dir, 'report-sys.pdf');

  // Fake Chrome: honors --print-to-pdf=<path> by writing a marker file.
  const fakeChrome = join(dir, 'fake-chrome.sh');
  writeFileSync(
    fakeChrome,
    '#!/bin/sh\nfor a in "$@"; do case "$a" in --print-to-pdf=*) printf "%s" "${a#--print-to-pdf=}" > "' + dir + '/target.txt";; esac; done\nprintf "%%PDF-fake" > "$(cat "' + dir + '/target.txt")"\n',
  );
  chmodSync(fakeChrome, 0o755);

  const printed = await printPdfHtml('<html><body>hi</body></html>', pdfPath, { chromePath: fakeChrome });
  assert.deepEqual(printed, { ok: true, pdfPath });
  assert.equal(readFileSync(pdfPath, 'utf8'), '%PDF-fake');

  const missing = await printPdfHtml('<html><body>hi</body></html>', pdfPath, { chromePath: null });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, 'no-chrome');
    assert.ok(existsSync(missing.htmlPath));
    assert.match(readFileSync(missing.htmlPath, 'utf8'), /hi/);
  }
});

test('collectExistingScreenshots only picks up screenshots already on disk', () => {
  const { run } = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'odsb-pdf-shots-'));
  const rec = run.records.find((r) => r.status === 'ok' && r.artifacts);
  assert.ok(rec?.artifacts);
  const cellDir = join(dir, rec.artifacts.dir);
  mkdirSync(cellDir, { recursive: true });

  assert.equal(collectExistingScreenshots(run, dir, 'my-system').length, 0);
  writeFileSync(join(cellDir, 'screenshot.png'), 'png');
  const shots = collectExistingScreenshots(run, dir, 'my-system');
  assert.equal(shots.length, 1);
  assert.match(shots[0].caption, new RegExp(rec.taskId));
});

test('authored model renders the validated document section by section', () => {
  const { run, stats } = fixture();
  const markdown = readFileSync(join(REPO_ROOT, 'docs', 'reports', 'report-example.md'), 'utf8');
  const parsed = parseReportFrontMatter(markdown, 'report-example.md');
  const { slices } = splitSections(parsed.body);
  const model = buildAuthoredPdfModel(stats, run, parsed.frontMatter as ReportDocument, slices);

  assert.equal(model.flavor, 'authored');
  assert.equal(model.title, 'My system');
  const findings = model.sections.find((s) => s.number === '5');
  assert.match(findings?.authoredMarkdown ?? '', /No AGENTS\.md at the system root/);
  const exec = model.sections.find((s) => s.number === '1');
  // The generated executive-summary block is itself the headline table; the
  // authored model must not add a second one.
  assert.match(exec?.authoredMarkdown ?? '', /Mean score across/);
  assert.equal(exec?.tables, undefined);
  const html = renderPdfHtml(model);
  assert.match(html, /Authored report/);
  assert.match(html, /skill steered the agent away/i);
});

test('authored model with supporting runs adds a runs-in-scope section', () => {
  const { run, stats } = fixture();
  const markdown = readFileSync(join(REPO_ROOT, 'docs', 'reports', 'report-example.md'), 'utf8');
  const parsed = parseReportFrontMatter(markdown, 'report-example.md');
  const doc = parsed.frontMatter as ReportDocument;
  doc.provenance.runs.push({
    runId: '20260201-000000-example-followup',
    profile: 'medium',
    role: 'supporting',
    cellCount: 4,
  });
  const { slices } = splitSections(parsed.body);
  const model = buildAuthoredPdfModel(stats, run, doc, slices);

  const scope = model.sections.find((s) => s.number === '2.5');
  assert.ok(scope, 'series reports list every run in scope');
  assert.equal(scope.tables?.[0].rows.length, 2);
  assert.match(model.coverRows.find(([k]) => k === 'Runs in scope')?.[1] ?? '', /supporting/);
});
