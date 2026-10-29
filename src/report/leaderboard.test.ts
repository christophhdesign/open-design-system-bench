// Synthetic-data verification for the leaderboard module. No disk fixtures
// except the demo HTML written at the end, for a human to open.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { AuditScore, Tier } from '../audit/score.ts';
import type { AuditCheckResult } from '../audit/types.ts';
import {
  collectLeaderboardEntries,
  rankEntries,
  rankingCohorts,
  renderLeaderboardHtml,
  type AuditReportFile,
  type LeaderboardEntry,
} from './leaderboard.ts';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeChecks(scores: Partial<Record<string, number | null>>): AuditCheckResult[] {
  const ids = ['surface', 'catalog-quality', 'export-hygiene', 'vocabulary', 'tokens', 'deprecation', 'docs-greppability'];
  return ids.map((id) => ({
    id,
    title: `title for ${id}`,
    score: scores[id] === undefined ? 50 : scores[id],
    findings:
      (scores[id] ?? 50) !== null && (scores[id] ?? 50)! < 40
        ? [{ severity: 'fail' as const, message: `${id} is weak`, fix: `improve ${id}` }]
        : [],
  }));
}

function surfaceOnlyScore(composite: number, checks: AuditCheckResult[]): AuditScore {
  const tier: Tier = composite >= 70 ? 'AI-native' : composite >= 40 ? 'Invested' : 'Emerging';
  const noRun = { score: null, note: 'no run provided' };
  return {
    surface: { score: composite, checks },
    lift: noRun,
    ceiling: noRun,
    engagement: noRun,
    vocabularyBehavioral: noRun,
    composite,
    basis: 'surface-only',
    tier,
    tierRationale: `composite ${composite}`,
  };
}

function makeEntry(system: string, composite: number, source = 'a.json'): LeaderboardEntry {
  const checks = makeChecks({});
  return { system, source, checks, score: surfaceOnlyScore(composite, checks) };
}

function makeReport(systems: Record<string, { composite: number }>): AuditReportFile {
  const out: AuditReportFile = { systemsConfigPath: 'x.json', run: null, systems: {} };
  for (const [id, { composite }] of Object.entries(systems)) {
    const checks = makeChecks({});
    out.systems[id] = { checks, score: surfaceOnlyScore(composite, checks) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// collect + rank
// ---------------------------------------------------------------------------

test('collectLeaderboardEntries flattens systems across files', () => {
  const entries = collectLeaderboardEntries([
    { path: 'a.json', report: makeReport({ alpha: { composite: 55 }, beta: { composite: 30 } }) },
    { path: 'b.json', report: makeReport({ gamma: { composite: 80 } }) },
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.source), ['a.json', 'a.json', 'b.json']);
});

test('duplicate system ids across files are refused, naming both files', () => {
  assert.throws(
    () =>
      collectLeaderboardEntries([
        { path: 'a.json', report: makeReport({ alpha: { composite: 55 } }) },
        { path: 'b.json', report: makeReport({ alpha: { composite: 60 } }) },
      ]),
    /alpha.*a\.json.*b\.json/s,
  );
});

test('a non-audit JSON file is refused with a pointed message', () => {
  assert.throws(
    () => collectLeaderboardEntries([{ path: 'oops.json', report: { hello: 'world' } as unknown as AuditReportFile }]),
    /oops\.json.*audit --json/s,
  );
});

test('rankEntries sorts composite desc with alphabetical tie-break, without mutating input', () => {
  const input = [makeEntry('zeta', 50), makeEntry('alpha', 50), makeEntry('top', 90)];
  const ranked = rankEntries(input);
  assert.deepEqual(ranked.map((e) => e.system), ['top', 'alpha', 'zeta']);
  assert.deepEqual(input.map((e) => e.system), ['zeta', 'alpha', 'top']);
});

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

test('renderLeaderboardHtml ranks rows and marks unmeasured behavioral scores n/a', () => {
  const html = renderLeaderboardHtml([makeEntry('sys-weak', 20), makeEntry('sys-strong', 85)], { generatedAt: '2026-08-25T00:00:00Z' });
  assert.ok(html.indexOf('sys-strong') < html.indexOf('sys-weak'), 'higher composite renders first');
  assert.match(html, /n\/a/);
  assert.match(html, /surface-only/);
  assert.match(html, /Emerging/);
  assert.match(html, /AI-native/);
});

test('system ids are HTML-escaped everywhere they render', () => {
  const html = renderLeaderboardHtml([makeEntry('<script>alert(1)</script>', 50)], { generatedAt: '2026-08-25T00:00:00Z' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('unknown check ids from future audits get appended columns instead of vanishing', () => {
  const entry = makeEntry('sys', 50);
  entry.checks = [...entry.checks, { id: 'novel-check', title: 'novel', score: 33, findings: [] }];
  const html = renderLeaderboardHtml([entry], { generatedAt: '2026-08-25T00:00:00Z' });
  assert.match(html, /novel-check/);
});

test('lift renders its raw signed delta when measured', () => {
  const entry = makeEntry('sys', 50);
  entry.score = {
    ...entry.score,
    lift: { score: 62, raw: 12.4, note: 'measured' },
    basis: 'partial-behavioral',
  };
  const html = renderLeaderboardHtml([entry], { generatedAt: '2026-08-25T00:00:00Z' });
  assert.match(html, /\+12\.4/);
  assert.match(html, /partial-behavioral/);
});

test('warn and fail findings surface in the what-to-fix section', () => {
  const checks = makeChecks({ 'export-hygiene': 10 });
  const entry: LeaderboardEntry = { system: 'gappy', source: 'a.json', checks, score: surfaceOnlyScore(35, checks) };
  const html = renderLeaderboardHtml([entry], { generatedAt: '2026-08-25T00:00:00Z' });
  assert.match(html, /What to fix/);
  assert.match(html, /export-hygiene is weak/);
  assert.match(html, /improve export-hygiene/);
});

test('demo leaderboard is written for a human to open', () => {
  const html = renderLeaderboardHtml(
    [makeEntry('system-a-demo', 61), makeEntry('system-b-demo', 48), makeEntry('system-c-demo', 72)],
    { generatedAt: '2026-08-25T00:00:00Z' },
  );
  const dir = mkdtempSync(join(tmpdir(), 'odsys-leaderboard-'));
  const out = join(dir, 'demo-leaderboard.html');
  writeFileSync(out, html);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  console.log(`demo leaderboard: ${out}`);
});

// ---------------------------------------------------------------------------
// ranking cohorts: composites from different evidence never share a rank
// ---------------------------------------------------------------------------

function behavioralEntry(system: string, composite: number, measured: Array<'lift' | 'ceiling' | 'engagement' | 'vocabularyBehavioral'>): LeaderboardEntry {
  const e = makeEntry(system, composite);
  const all = ['lift', 'ceiling', 'engagement', 'vocabularyBehavioral'] as const;
  for (const k of all) e.score[k] = measured.includes(k) ? { score: 60, note: 'measured' } : { score: null, note: 'n/a' };
  e.score.basis = measured.length === all.length ? 'full-behavioral' : 'partial-behavioral';
  return e;
}

test('mixed evidence is ranked in separate cohorts, run-backed first, ranks restarting', () => {
  const entries = [makeEntry('static-high', 95), behavioralEntry('run-low', 40, ['lift', 'ceiling', 'engagement', 'vocabularyBehavioral']), makeEntry('static-low', 30)];
  const cohorts = rankingCohorts(entries);
  assert.deepEqual(cohorts.map((c) => [c.key, c.entries.map((e) => e.system)]), [
    ['full-behavioral', ['run-low']],
    ['surface-only', ['static-high', 'static-low']],
  ]);
  const html = renderLeaderboardHtml(entries, { generatedAt: '2026-10-27T00:00:00Z' });
  assert.match(html, /<h2>Rankings<\/h2>/);
  assert.match(html, /never across tables/);
  // Both tables start at 1: a 95 static composite does not outrank a 40 run-backed one.
  assert.equal((html.match(/<td class="num">1<\/td>/g) ?? []).length, 2);
});

test('partial runs with different sub-scores are different cohorts', () => {
  const cohorts = rankingCohorts([
    behavioralEntry('ceiling-only', 70, ['ceiling', 'engagement']),
    behavioralEntry('with-lift', 60, ['lift', 'ceiling', 'engagement']),
    behavioralEntry('also-ceiling-only', 50, ['ceiling', 'engagement']),
  ]);
  assert.deepEqual(cohorts.map((c) => c.entries.map((e) => e.system)), [['ceiling-only', 'also-ceiling-only'], ['with-lift']]);
  assert.match(cohorts[0]!.title, /partial run \(ceiling, engagement\)/);
});

test('a homogeneous leaderboard keeps its single ranking', () => {
  const html = renderLeaderboardHtml([makeEntry('a', 80), makeEntry('b', 60)], { generatedAt: '2026-10-27T00:00:00Z' });
  assert.match(html, /<h2>Ranking<\/h2>/);
  assert.ok(!html.includes('class="lb-cohort"'));
});
