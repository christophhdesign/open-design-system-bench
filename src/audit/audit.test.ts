import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunManifest, RunResults, SystemCatalog, SystemConfig } from '../types.ts';
import { catalogPath } from '../config.ts';
import { buildRunResults } from '../report/aggregate.ts';
import { AUDIT_CHECKS, runAuditChecks } from './run.ts';
import { computeAuditScore } from './score.ts';
import { checkExportHygiene } from './checks/export-hygiene.ts';
import { checkVocabulary } from './checks/vocabulary.ts';
import { checkSurface } from './checks/surface.ts';

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Builds a synthetic design system on disk:
 *  - packages/components/package.json declares an exports map with "./toggle"
 *    (mirrors the barrel) and "./badge" (a dir the barrel does NOT cover —
 *    reachable only via the exports map, and must NOT be flagged).
 *  - the root barrel (src/index.ts) only re-exports "./toggle".
 *  - three component dirs: toggle/ (barrel-reachable), badge/
 *    (exports-map-only reachable), stack/ (reachable via neither — the one
 *    export-hygiene must flag).
 *  - AGENTS.md at the system root.
 *  - a foundations css with a mix of primitive and var()-referencing vars.
 *  - a pre-extracted catalog snapshot (SystemCatalog shape) at
 *    catalogPath(system, catalogsDir) exposing "Toggle" (not "Switch") and a
 *    "Stack" component whose prop is "gap" (not "spacing") — lexicon-aligned
 *    on the alias, misaligned on the convention name.
 */
function buildSyntheticSystem(): { root: string; cfg: SystemConfig; catalogsDir: string; tokensDir: string; system: string } {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-'));
  const system = 'testkit';

  writeFile(join(root, 'AGENTS.md'), '# Testkit agent guide\n\nUse Toggle for on/off state.\n');

  writeFile(
    join(root, 'packages/components/package.json'),
    JSON.stringify(
      {
        name: '@testkit/components',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: { '.': './dist/index.js', './toggle': './dist/toggle/index.js', './badge': './dist/badge/index.js' },
      },
      null,
      2,
    ),
  );

  writeFile(join(root, 'packages/components/src/index.ts'), "export * from './toggle';\n");

  writeFile(join(root, 'packages/components/src/toggle/index.ts'), 'export function Toggle() { return null; }\n');
  writeFile(join(root, 'packages/components/src/badge/index.ts'), 'export function Badge() { return null; }\n');
  writeFile(join(root, 'packages/components/src/stack/index.ts'), 'export function Stack() { return null; }\n');

  writeFile(
    join(root, 'packages/foundations/src/index.css'),
    [
      ':root {',
      '  --color-blue-500: #1a73e8;',
      '  --color-text-primary: var(--color-blue-500);',
      '  --spacing-4: 16px;',
      '}',
    ].join('\n'),
  );

  const catalogsDir = join(root, '.audit-data', 'catalogs');
  const tokensDir = join(root, '.audit-data', 'tokens');

  const catalog: SystemCatalog = {
    system,
    generatedAt: new Date().toISOString(),
    source: { root, commit: 'test', srcHash: 'test' },
    components: [
      {
        dir: 'toggle',
        exports: [
          { displayName: 'Toggle', description: 'An on/off control.', props: [{ name: 'checked', type: 'boolean', required: false, defaultValue: 'false', description: 'Whether the toggle is on.' }] },
        ],
      },
      {
        dir: 'stack',
        exports: [
          { displayName: 'Stack', description: 'A vertical layout primitive.', props: [{ name: 'gap', type: 'string', required: false, description: 'Space between children.' }] },
        ],
      },
    ],
    allExports: ['Toggle', 'Stack'],
    allPropsByExport: { Toggle: ['checked'], Stack: ['gap'] },
  };
  mkdirSync(catalogsDir, { recursive: true });
  writeFileSync(catalogPath(system, catalogsDir), JSON.stringify(catalog, null, 2));

  const cfg: SystemConfig = {
    root,
    rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_TESTKIT_DIR',
    componentsSrc: 'packages/components/src',
    componentsPkg: '@testkit/components',
    foundationsPkg: '@testkit/foundations',
    foundationsCss: 'packages/foundations/src/index.css',
    catalogStrategy: 'catalog-json',
    catalogFile: 'packages/components/catalog.json', // deliberately not present on disk — pre-extracted snapshot above is what should be used
    agentContext: { agentsMd: ['AGENTS.md'] },
  };

  return { root, cfg, catalogsDir, tokensDir, system };
}

test('export-hygiene flags the dir reachable via neither the barrel nor the exports map', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    const result = await checkExportHygiene(system, cfg, { catalogsDir, tokensDir });
    const flaggedMessages = result.findings.filter((f) => f.severity === 'fail').map((f) => f.message);
    assert.ok(flaggedMessages.some((m) => m.includes('stack/')), `expected stack/ to be flagged, got: ${JSON.stringify(flaggedMessages)}`);
    assert.ok(!flaggedMessages.some((m) => m.includes('toggle/')), 'toggle/ (barrel-reachable) must not be flagged');
    assert.ok(!flaggedMessages.some((m) => m.includes('badge/')), 'badge/ (exports-map-reachable) must not be flagged');
    assert.equal(typeof result.score, 'number');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export-hygiene counts named value re-exports as reachable, but not type-only re-exports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-named-'));
  const system = 'namedkit';
  try {
    writeFile(
      join(root, 'packages/components/package.json'),
      JSON.stringify({ name: '@namedkit/components', main: './dist/index.js', types: './dist/index.d.ts', exports: { '.': './dist/index.js' } }),
    );
    // Named re-exports, no `export *` anywhere,
    // plus one type-only re-export that must NOT make its dir reachable.
    writeFile(
      join(root, 'packages/components/src/index.ts'),
      "export { Button } from './button';\nexport type { CardProps } from './card';\n",
    );
    writeFile(join(root, 'packages/components/src/button/index.tsx'), 'export const Button = () => <button />;\n');
    writeFile(join(root, 'packages/components/src/card/index.ts'), 'export function Card() { return null; }\nexport interface CardProps { title: string }\n');
    writeFile(join(root, 'packages/components/src/internal/index.ts'), 'export function usePrivateThing() { return null; }\n');

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_NAMEDKIT_DIR',
      componentsSrc: 'packages/components/src',
      componentsPkg: '@namedkit/components',
      foundationsPkg: '@namedkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkExportHygiene(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    const flagged = result.findings.filter((f) => f.severity === 'fail').map((f) => f.message);
    assert.ok(!flagged.some((m) => m.includes('button/')), `button/ (named value re-export) must not be flagged, got: ${JSON.stringify(flagged)}`);
    assert.ok(flagged.some((m) => m.includes('card/')), `card/ (type-only re-export) must be flagged, got: ${JSON.stringify(flagged)}`);
    assert.ok(!flagged.some((m) => m.includes('internal/')), `internal/ (conventionally private) must not be flagged, got: ${JSON.stringify(flagged)}`);
    assert.ok(
      result.findings.some((f) => f.severity === 'info' && f.message.includes('internal/') && f.message.includes('intentionally non-public')),
      'internal/ exclusion is disclosed as an info finding',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('vocabulary reports Switch->Toggle and spacing->gap as convention distance', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    const result = await checkVocabulary(system, cfg, { catalogsDir, tokensDir });
    assert.equal(typeof result.score, 'number');
    const messages = result.findings.map((f) => f.message);
    assert.ok(
      messages.some((m) => m.includes('"Switch"') && m.includes('"Toggle"')),
      `expected a Switch->Toggle distance finding, got: ${JSON.stringify(messages)}`,
    );
    assert.ok(
      messages.some((m) => m.includes('"spacing"') && m.includes('"gap"')),
      `expected a spacing->gap distance finding, got: ${JSON.stringify(messages)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface counts AGENTS.md as present', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });
    assert.ok(
      result.findings.some((f) => f.message.includes('AGENTS.md')),
      `expected an AGENTS.md finding, got: ${JSON.stringify(result.findings)}`,
    );
    assert.equal(typeof result.score, 'number');
    assert.ok((result.score as number) > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('all seven checks run without throwing on a minimal/empty system', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-empty-'));
  try {
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_EMPTY_DIR',
      componentsSrc: 'src', // does not exist
      componentsPkg: '@empty/components',
      foundationsPkg: '@empty/foundations',
      // no foundationsCss, no catalogFile
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const catalogsDir = join(root, 'catalogs'); // does not exist
    const tokensDir = join(root, 'tokens'); // does not exist

    const results = await runAuditChecks('empty', cfg, { catalogsDir, tokensDir });
    assert.equal(results.length, AUDIT_CHECKS.length);
    assert.equal(results.length, 7);
    for (const r of results) {
      assert.ok(r.score === null || typeof r.score === 'number', `${r.id}: score must be number|null, got ${r.score}`);
      assert.ok(Array.isArray(r.findings));
      assert.ok(
        !r.findings.some((f) => f.message.startsWith('Check crashed')),
        `${r.id} fell through to the crash fallback instead of degrading gracefully: ${JSON.stringify(r.findings)}`,
      );
    }

    const score = computeAuditScore(results, undefined, 'empty');
    assert.equal(score.basis, 'surface-only');
    assert.ok(['Emerging', 'Invested', 'AI-native'].includes(score.tier));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('score assembly produces a tier from the synthetic system (surface-only)', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    const checks = await runAuditChecks(system, cfg, { catalogsDir, tokensDir });
    assert.equal(checks.length, 7);
    const score = computeAuditScore(checks, undefined, system);
    assert.equal(score.basis, 'surface-only');
    assert.ok(['Emerging', 'Invested', 'AI-native'].includes(score.tier));
    assert.equal(score.lift.score, null);
    assert.equal(score.ceiling.score, null);
    assert.equal(score.engagement.score, null);
    assert.equal(score.vocabularyBehavioral.score, null);
    assert.equal(typeof score.surface.score, 'number');
    assert.equal(score.composite, score.surface.score);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('score assembly computes Lift/Ceiling/Engagement/Vocabulary-behavioral from a RunResults file', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    const checks = await runAuditChecks(system, cfg, { catalogsDir, tokensDir });

    const manifest: RunManifest = {
      runId: 'test-run',
      profile: 'smoke',
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      adapters: {},
      systems: {},
      cells: [],
    };

    const records: RunResults['records'] = [
      {
        cell: { system, context: 'bare', model: 'test-model', agent: 'claude-code' },
        taskId: 'task-a',
        rep: 1,
        status: 'ok',
        result: {
          overall: 40,
          gate: 'fail',
          dimensions: { apiFidelity: { dimension: 'apiFidelity', score: 0, gate: 'fail', diffs: [{ dimension: 'apiFidelity', message: 'no design-system components used' }] } },
          diffs: [{ dimension: 'apiFidelity', message: 'no design-system components used' }],
        },
      },
      {
        cell: { system, context: 'agents-md', model: 'test-model', agent: 'claude-code' },
        taskId: 'task-a',
        rep: 1,
        status: 'ok',
        result: {
          overall: 70,
          gate: 'review',
          dimensions: { apiFidelity: { dimension: 'apiFidelity', score: 60, gate: 'review', diffs: [] } },
          diffs: [{ dimension: 'apiFidelity', message: "Hallucinated component 'Switch' imported from @testkit/components in src/App.tsx" }],
        },
      },
      {
        cell: { system, context: 'agents-md', model: 'test-model', agent: 'claude-code' },
        taskId: 'task-b',
        rep: 1,
        status: 'ok',
        result: {
          overall: 90,
          gate: 'pass',
          dimensions: { apiFidelity: { dimension: 'apiFidelity', score: 100, gate: 'pass', diffs: [] } },
          diffs: [],
        },
      },
    ];

    const run = buildRunResults(manifest, records);
    const score = computeAuditScore(checks, run, system);

    assert.equal(score.basis, 'full-behavioral');
    assert.equal(score.lift.raw, 40); // guided mean 80 - bare mean 40
    assert.equal(score.lift.score, 90); // clamp(50 + 40, 0, 100)
    assert.ok(score.ceiling.score !== null && score.ceiling.score > 80); // guided mean 80, 100% non-fail
    assert.ok(score.engagement.score !== null && score.engagement.score < 100); // 1/3 ok cells ignored the system
    assert.equal(score.vocabularyBehavioral.score, 0); // the one hallucination ("Switch") is a lexicon-exact match
    assert.ok(['Emerging', 'Invested', 'AI-native'].includes(score.tier));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
