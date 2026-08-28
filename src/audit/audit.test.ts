import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';

import type { RunManifest, RunResults, SystemCatalog, SystemConfig } from '../types.ts';
import { catalogPath } from '../config.ts';
import { buildRunResults } from '../report/aggregate.ts';
import { AUDIT_CHECKS, resolveHostedSurface, runAuditChecks } from './run.ts';
import { computeAuditScore } from './score.ts';
import { checkExportHygiene } from './checks/export-hygiene.ts';
import { checkVocabulary } from './checks/vocabulary.ts';
import { checkSurface } from './checks/surface.ts';
import { hasDarkSignal } from './checks/tokens.ts';
import { checkDocsGreppability } from './checks/docs-greppability.ts';
import { checkCatalogQuality } from './checks/catalog-quality.ts';
import { checkDeprecation } from './checks/deprecation.ts';
import { listWorkspacePackages } from './workspace.ts';
import { probeHostedSurface } from './hosted.ts';

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

// ---------------------------------------------------------------------------
// Field-test fixes: export-hygiene dist/ heuristic, tokens dark-signal
// regex, docs-greppability compound names + fallback cap, surface git-based
// freshness, catalog-quality zero-prop findings.
// ---------------------------------------------------------------------------

test('export-hygiene treats esm/cjs/lib (and bare index.js) build outputs as built output, not just dist/', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-builtoutput-'));
  const system = 'builtoutputkit';
  try {
    // No "dist/" anywhere on purpose: main points at esm/, exports["."] at
    // cjs/, the exact shape that used to false-positive as "no dist entry".
    writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@builtoutputkit/components',
        main: './esm/index.mjs',
        types: './esm/index.d.ts',
        exports: { '.': './cjs/index.cjs' },
      }),
    );
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_BUILTOUTPUTKIT_DIR',
      componentsSrc: 'src', // does not exist; package.json lives at root
      componentsPkg: '@builtoutputkit/components',
      foundationsPkg: '@builtoutputkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkExportHygiene(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    assert.ok(
      !result.findings.some((f) => f.message.includes('raw source')),
      `esm/cjs entries must not be flagged as raw source, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export-hygiene flags entries that point at raw src/ or .ts/.tsx, naming the offending values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-rawsrc-'));
  const system = 'rawsrckit';
  try {
    writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: '@rawsrckit/components', main: './src/index.ts', types: './dist/index.d.ts' }),
    );
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_RAWSRCKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@rawsrckit/components',
      foundationsPkg: '@rawsrckit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkExportHygiene(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    const rawSourceFinding = result.findings.find((f) => f.message.includes('raw source'));
    assert.ok(rawSourceFinding, `expected a raw-source finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(
      rawSourceFinding!.message.includes('main="./src/index.ts"'),
      `finding should name the offending value, got: ${rawSourceFinding!.message}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tokens.hasDarkSignal matches prefers-color-scheme, data-*theme/color-scheme attributes, .dark selectors, and color-scheme declarations', () => {
  const positive = [
    '[data-mantine-color-scheme="dark"] { --x: 1; }',
    '[data-theme="dark"] { --x: 1; }',
    '@media (prefers-color-scheme: dark) { :root { --x: 1; } }',
    '.dark {\n  --x: 1;\n}',
    'html.dark .x { --x: 1; }',
    'color-scheme: light dark;',
  ];
  for (const css of positive) {
    assert.ok(hasDarkSignal(css), `expected a dark signal in: ${css}`);
  }

  const negative = ['.darker {\n  --x: 1;\n}', '--dark-shadow: 1px 1px 0 black;', '/* dark magic happens here */'];
  for (const css of negative) {
    assert.ok(!hasDarkSignal(css), `did not expect a dark signal in: ${css}`);
  }
});

test('docs-greppability matches dotted compound names (Accordion.ItemBody) against flattened catalog export names', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-dotted-'));
  const system = 'dottedkit';
  try {
    writeFile(join(root, 'docs/accordion.md'), '# Accordion\n\nUse `Accordion.ItemBody` for the collapsible body content.\n');

    const catalogsDir = join(root, '.audit-data', 'catalogs');
    mkdirSync(catalogsDir, { recursive: true });
    const catalog: SystemCatalog = {
      system,
      generatedAt: new Date().toISOString(),
      source: { root, commit: 'test', srcHash: 'test' },
      components: [
        {
          dir: 'accordion',
          exports: [
            { displayName: 'Accordion', description: 'Root.', props: [] },
            { displayName: 'AccordionItemBody', description: 'Body.', props: [] },
          ],
        },
      ],
      allExports: ['Accordion', 'AccordionItemBody'],
      allPropsByExport: {},
    };
    writeFileSync(catalogPath(system, catalogsDir), JSON.stringify(catalog, null, 2));

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_DOTTEDKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@dottedkit/components',
      foundationsPkg: '@dottedkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkDocsGreppability(system, cfg, { catalogsDir, tokensDir: join(root, 'tokens') });
    const coverageFinding = result.findings.find((f) => f.message.includes('mentioned in at least one markdown file'));
    assert.ok(coverageFinding, `expected a coverage finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(
      coverageFinding!.message.startsWith('2/2'),
      `expected both exports covered (direct + dotted-variant match), got: ${coverageFinding!.message}`,
    );
    assert.ok(
      !result.findings.some((f) => f.message.includes('AccordionItemBody') && f.severity === 'warn'),
      'AccordionItemBody must not be reported as uncovered once its dotted form is found',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs-greppability fallback mode (no catalog) is capped at 40 and labeled not comparable to coverage mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-fallback-'));
  const system = 'fallbackkit';
  try {
    // Plenty of markdown, but no catalog anywhere (docgen strategy, no
    // tsconfig, no .tsx files): this must NOT be able to out-score a real
    // measured-coverage result.
    for (let i = 0; i < 25; i++) {
      writeFile(join(root, `docs/file-${i}.md`), `# Doc ${i}\n`);
    }
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_FALLBACKKIT_DIR',
      componentsSrc: 'src', // does not exist
      componentsPkg: '@fallbackkit/components',
      foundationsPkg: '@fallbackkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const catalogsDir = join(root, 'catalogs'); // does not exist
    const result = await checkDocsGreppability(system, cfg, { catalogsDir, tokensDir: join(root, 'tokens') });
    assert.equal(result.score, 40, `expected the fallback cap of 40 at >=20 markdown files, got ${result.score}`);
    assert.ok(
      result.findings.some((f) => f.message.includes('capped at 40') && f.message.includes('not comparable')),
      `expected a cap/mode-comparability finding, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function initGitRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'audit-test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Audit Test'], { cwd: root });
}

function gitCommitAll(root: string, message: string, isoDate: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  });
}

test('surface freshness uses git commit history: fresh docs earn +5, stale docs get a warn with no bonus', async () => {
  function buildFreshnessRepo(order: 'docs-after-source' | 'docs-before-source'): { root: string; cfg: SystemConfig } {
    const root = mkdtempSync(join(tmpdir(), `open-design-system-bench-audit-freshness-${order}-`));
    initGitRepo(root);
    const writeSource = () => writeFile(join(root, 'packages/components/src/toggle/index.ts'), 'export function Toggle() { return null; }\n');
    const writeDocs = () => writeFile(join(root, 'AGENTS.md'), '# Freshkit agent guide\n');

    if (order === 'docs-after-source') {
      writeSource();
      gitCommitAll(root, 'add source', '2024-01-01T00:00:00Z');
      writeDocs();
      gitCommitAll(root, 'add docs', '2024-06-01T00:00:00Z');
    } else {
      writeDocs();
      gitCommitAll(root, 'add docs', '2024-01-01T00:00:00Z');
      writeSource();
      gitCommitAll(root, 'update source', '2024-06-01T00:00:00Z');
    }

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_FRESHKIT_DIR',
      componentsSrc: 'packages/components/src',
      componentsPkg: '@freshkit/components',
      foundationsPkg: '@freshkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    return { root, cfg };
  }

  const fresh = buildFreshnessRepo('docs-after-source');
  const stale = buildFreshnessRepo('docs-before-source');
  try {
    const freshResult = await checkSurface('freshkit', fresh.cfg, { catalogsDir: join(fresh.root, 'c'), tokensDir: join(fresh.root, 't') });
    const staleResult = await checkSurface('freshkit', stale.cfg, { catalogsDir: join(stale.root, 'c'), tokensDir: join(stale.root, 't') });

    assert.ok(
      freshResult.findings.some((f) => f.severity === 'info' && f.message.includes('as new as or newer') && f.message.includes('git history')),
      `expected a fresh-docs info finding, got: ${JSON.stringify(freshResult.findings)}`,
    );
    assert.ok(
      staleResult.findings.some((f) => f.severity === 'warn' && f.message.includes('predate') && f.message.includes('git history')),
      `expected a stale-docs warn finding, got: ${JSON.stringify(staleResult.findings)}`,
    );
    assert.ok(!staleResult.findings.some((f) => f.message.includes('as new as or newer')), 'stale case must not also claim freshness');

    assert.equal(typeof freshResult.score, 'number');
    assert.equal(typeof staleResult.score, 'number');
    assert.equal(
      (freshResult.score as number) - (staleResult.score as number),
      5,
      'the only difference between the two repos is commit order, so the freshness bonus should be exactly +5',
    );
  } finally {
    rmSync(fresh.root, { recursive: true, force: true });
    rmSync(stale.root, { recursive: true, force: true });
  }
});

test('surface freshness is unmeasured (no bonus, no warning) outside a git checkout', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });
    assert.ok(
      result.findings.some((f) => f.severity === 'info' && f.message.includes('Doc freshness unmeasured')),
      `expected an unmeasured-freshness info finding, got: ${JSON.stringify(result.findings)}`,
    );
    assert.ok(
      !result.findings.some((f) => f.message.includes('git history')),
      'must not claim a git-history-based freshness verdict outside a git checkout',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeCatalogQualityCatalog(system: string, root: string, zeroPropCount: number, withPropsCount: number): SystemCatalog {
  const components: SystemCatalog['components'] = [];
  for (let i = 0; i < zeroPropCount; i++) {
    components.push({ dir: `zero-${i}`, exports: [{ displayName: `Zero${i}`, description: 'x', props: [] }] });
  }
  for (let i = 0; i < withPropsCount; i++) {
    components.push({
      dir: `full-${i}`,
      exports: [
        {
          displayName: `Full${i}`,
          description: 'x',
          props: [{ name: 'value', type: 'string', required: false, defaultValue: 'x', description: 'x' }],
        },
      ],
    });
  }
  return {
    system,
    generatedAt: new Date().toISOString(),
    source: { root, commit: 'test', srcHash: 'test' },
    components,
    allExports: components.flatMap((c) => c.exports.map((e) => e.displayName)),
    allPropsByExport: {},
  };
}

test('catalog-quality names zero-prop exports as likely extraction gaps, without marking extraction-suspect below 30%', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-zeroprop-'));
  const system = 'zeropropkit';
  try {
    const catalogsDir = join(root, '.audit-data', 'catalogs');
    mkdirSync(catalogsDir, { recursive: true });
    writeFileSync(catalogPath(system, catalogsDir), JSON.stringify(makeCatalogQualityCatalog(system, root, 2, 8), null, 2)); // 2/10 = 20%

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_ZEROPROPKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@zeropropkit/components',
      foundationsPkg: '@zeropropkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkCatalogQuality(system, cfg, { catalogsDir, tokensDir: join(root, 'tokens') });

    const zeroFinding = result.findings.find((f) => f.message.includes('zero documented props'));
    assert.ok(zeroFinding, `expected a zero-prop finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(zeroFinding!.message.startsWith('2/10'), `expected 2/10 zero-prop exports named, got: ${zeroFinding!.message}`);
    assert.ok(
      !result.findings.some((f) => f.message.startsWith('extraction-suspect')),
      `must not mark extraction-suspect below 30%, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('catalog-quality marks extraction-suspect at >=30% zero-prop exports and reports coverage over the rest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-suspect-'));
  const system = 'suspectkit';
  try {
    const catalogsDir = join(root, '.audit-data', 'catalogs');
    mkdirSync(catalogsDir, { recursive: true });
    writeFileSync(catalogPath(system, catalogsDir), JSON.stringify(makeCatalogQualityCatalog(system, root, 4, 6), null, 2)); // 4/10 = 40%

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_SUSPECTKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@suspectkit/components',
      foundationsPkg: '@suspectkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkCatalogQuality(system, cfg, { catalogsDir, tokensDir: join(root, 'tokens') });

    const suspectFinding = result.findings.find((f) => f.message.startsWith('extraction-suspect'));
    assert.ok(suspectFinding, `expected an extraction-suspect finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(suspectFinding!.message.includes('40%'), `expected the finding to name 40%, got: ${suspectFinding!.message}`);
    assert.ok(
      suspectFinding!.message.includes('lower bound'),
      `expected the finding to warn the numbers below are a lower bound, got: ${suspectFinding!.message}`,
    );
    // All 6 "full" exports have a resolved type/default/description, so
    // type/description coverage over the non-zero-prop exports is 100%:
    // no separate "Only X%" warn should fire for type or description.
    assert.ok(
      !result.findings.some((f) => f.message.includes('% of props have a resolved type')),
      `type coverage over non-zero-prop exports should be 100%, got: ${JSON.stringify(result.findings)}`,
    );
    assert.ok(
      !result.findings.some((f) => f.message.includes('% of props have a description')),
      `description coverage over non-zero-prop exports should be 100%, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export-hygiene reachability understands NodeNext specifiers (./dir/index.js, ./dir.js)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-nodenext-reach-'));
  const system = 'nodenextkit';
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: '@nodenextkit/components', main: './dist/index.js' }));
    // Both dirs have their own index.ts and ARE re-exported by the root
    // barrel, just with NodeNext .js extensions on the specifiers — the
    // shape that used to be flagged unreachable.
    writeFile(join(root, 'src', 'index.ts'), "export * from './alpha/index.js';\nexport { Beta } from './beta.js';\n");
    writeFile(join(root, 'src', 'alpha', 'index.ts'), "export const Alpha = () => null;\n");
    writeFile(join(root, 'src', 'beta', 'index.ts'), "export const Beta = () => null;\n");
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_NODENEXTKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@nodenextkit/components',
      foundationsPkg: '@nodenextkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkExportHygiene(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    const unreachable = result.findings.filter((f) => f.message.includes('not reachable'));
    assert.equal(unreachable.length, 0, `NodeNext-specifier re-exports flagged unreachable: ${JSON.stringify(unreachable)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export-hygiene treats an exports-map "./*" wildcard as making every component dir reachable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-wildcard-exports-'));
  const system = 'wildcardkit';
  try {
    // utils/ has an index.ts and is NOT in the root barrel, but the exports
    // map's "./*" wildcard makes it importable as a subpath — the Chakra
    // shape that used to be flagged unreachable.
    writeFile(join(root, 'package.json'), JSON.stringify({ name: '@wildcardkit/components', main: './dist/index.js', exports: { '.': './dist/index.js', './*': './dist/*' } }));
    writeFile(join(root, 'src', 'index.ts'), "export * from './alpha';\n");
    writeFile(join(root, 'src', 'alpha', 'index.ts'), 'export const Alpha = () => null;\n');
    writeFile(join(root, 'src', 'utils', 'index.ts'), 'export const cx = (...xs: string[]) => xs.join(" ");\n');
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_WILDCARDKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@wildcardkit/components',
      foundationsPkg: '@wildcardkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkExportHygiene(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    const unreachable = result.findings.filter((f) => f.message.includes('not reachable'));
    assert.equal(unreachable.length, 0, `wildcard exports map must make dirs reachable: ${JSON.stringify(unreachable)}`);
    assert.ok(result.findings.some((f) => f.message.includes('"./*" wildcard')), 'expected the wildcard info finding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Field-test fixes (P2): workspace-wide discovery. A real monorepo commonly
// ships its MCP server, codemod package, or per-package CHANGELOG in a
// sibling workspace package rather than in the components package itself or
// at the repo root — invisible to the pre-P2 checks. src/audit/workspace.ts
// covers both declaration shapes (package.json "workspaces", pnpm-workspace.yaml).
// ---------------------------------------------------------------------------

test('surface finds an MCP hint in a workspace package declared via pnpm-workspace.yaml, and names the package', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'apps/*'\n");
    writeFile(
      join(root, 'apps/mcp/package.json'),
      JSON.stringify({ name: '@testkit/mcp-server', dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' } }, null, 2),
    );

    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });
    const hit = result.findings.find((f) => f.message.includes('MCP server found in workspace package'));
    assert.ok(hit, `expected an MCP workspace-hint finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(hit!.message.includes('apps/mcp'), `finding should name apps/mcp, got: ${hit!.message}`);
    assert.ok(hit!.message.includes('@testkit/mcp-server'), `finding should name the package, got: ${hit!.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deprecation finds a codemod package via package.json workspaces, and names it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-codemod-'));
  const system = 'codemodkit';
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'codemodkit-monorepo', private: true, workspaces: ['packages/*'] }, null, 2));
    writeFile(join(root, 'packages/components/package.json'), JSON.stringify({ name: '@codemodkit/components' }, null, 2));
    writeFile(join(root, 'packages/components/src/index.ts'), 'export function Widget() { return null; }\n');
    // Chakra ships packages/codemod: a workspace package whose own name (not
    // a root-level codemods/ dir or script) is the only signal.
    writeFile(join(root, 'packages/codemod/package.json'), JSON.stringify({ name: '@codemodkit/codemod' }, null, 2));

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_CODEMODKIT_DIR',
      componentsSrc: 'packages/components/src',
      componentsPkg: '@codemodkit/components',
      foundationsPkg: '@codemodkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkDeprecation(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    const hit = result.findings.find((f) => f.message.includes('Codemod package found in workspace package'));
    assert.ok(hit, `expected a codemod workspace-package finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(hit!.message.includes('packages/codemod'), `finding should name packages/codemod, got: ${hit!.message}`);
    assert.ok(hit!.message.includes('@codemodkit/codemod'), `finding should name the package, got: ${hit!.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deprecation credits a CHANGELOG.md found only in a sibling workspace package (not root, not the components package)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-siblingchangelog-'));
  const system = 'siblingchangelogkit';
  try {
    writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'siblingchangelogkit-monorepo', private: true, workspaces: ['packages/*'] }, null, 2),
    );
    writeFile(join(root, 'packages/components/package.json'), JSON.stringify({ name: '@siblingchangelogkit/components' }, null, 2));
    writeFile(join(root, 'packages/components/src/index.ts'), 'export function Widget() { return null; }\n');
    // No CHANGELOG.md at root or in packages/components — only in a sibling workspace package.
    writeFile(join(root, 'packages/theme/package.json'), JSON.stringify({ name: '@siblingchangelogkit/theme' }, null, 2));
    writeFile(join(root, 'packages/theme/CHANGELOG.md'), '# theme\n\n## 2.0.0\n\n- Repaint.\n');

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_SIBLINGCHANGELOGKIT_DIR',
      componentsSrc: 'packages/components/src',
      componentsPkg: '@siblingchangelogkit/components',
      foundationsPkg: '@siblingchangelogkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkDeprecation(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    assert.ok((result.score as number) >= 25, `expected changelog presence credit sourced from the sibling package, got score ${result.score}`);
    const countFinding = result.findings.find((f) => f.message.includes('workspace package(s) carry their own changelog'));
    assert.ok(countFinding, `expected a workspace-changelog-count finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(
      countFinding!.message.includes('packages/theme/CHANGELOG.md'),
      `finding should name the example path, got: ${countFinding!.message}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface reports builder-side agent tooling (.claude/agents, .claude/commands) as an info finding, but does not score it', async () => {
  const withTooling = buildSyntheticSystem();
  const withoutTooling = buildSyntheticSystem();
  try {
    writeFile(join(withTooling.root, '.claude/agents/reviewer.md'), '# reviewer\n');
    writeFile(join(withTooling.root, '.claude/agents/planner.md'), '# planner\n');
    writeFile(join(withTooling.root, '.claude/commands/deploy.md'), '# deploy\n');

    const withResult = await checkSurface(withTooling.system, withTooling.cfg, {
      catalogsDir: withTooling.catalogsDir,
      tokensDir: withTooling.tokensDir,
    });
    const withoutResult = await checkSurface(withoutTooling.system, withoutTooling.cfg, {
      catalogsDir: withoutTooling.catalogsDir,
      tokensDir: withoutTooling.tokensDir,
    });

    const finding = withResult.findings.find((f) => f.message.startsWith('Builder-side agent tooling found'));
    assert.ok(finding, `expected a builder-tooling finding, got: ${JSON.stringify(withResult.findings)}`);
    assert.ok(finding!.message.includes('.claude/agents (2)'), `expected an agents count of 2, got: ${finding!.message}`);
    assert.ok(finding!.message.includes('.claude/commands (1)'), `expected a commands count of 1, got: ${finding!.message}`);
    assert.ok(
      !withoutResult.findings.some((f) => f.message.startsWith('Builder-side agent tooling found')),
      'a system with no .claude/ tooling must not get the finding',
    );
    assert.equal(
      withResult.score,
      withoutResult.score,
      'builder-tooling is deliberately unscored: score must be identical with or without it',
    );
  } finally {
    rmSync(withTooling.root, { recursive: true, force: true });
    rmSync(withoutTooling.root, { recursive: true, force: true });
  }
});

test('listWorkspacePackages resolves globs from package.json "workspaces" (array form)', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-workspace-pkgjson-'));
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo', private: true, workspaces: ['packages/*'] }, null, 2));
    writeFile(join(root, 'packages/alpha/package.json'), JSON.stringify({ name: '@monorepo/alpha' }, null, 2));
    writeFile(join(root, 'packages/beta/package.json'), JSON.stringify({ name: '@monorepo/beta' }, null, 2));
    mkdirSync(join(root, 'packages/not-a-package'), { recursive: true }); // no package.json — must not appear

    const result = listWorkspacePackages(root);
    assert.deepEqual(result.map((r) => r.relDir).sort(), ['packages/alpha', 'packages/beta']);
    const alpha = result.find((r) => r.relDir === 'packages/alpha');
    assert.equal((alpha?.pkg as { name?: string } | undefined)?.name, '@monorepo/alpha');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspacePackages resolves globs from package.json "workspaces" (object form { packages })', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-workspace-objform-'));
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo', private: true, workspaces: { packages: ['packages/*'] } }, null, 2));
    writeFile(join(root, 'packages/gamma/package.json'), JSON.stringify({ name: '@monorepo/gamma' }, null, 2));

    const result = listWorkspacePackages(root);
    assert.deepEqual(result.map((r) => r.relDir), ['packages/gamma']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspacePackages resolves globs from pnpm-workspace.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-workspace-pnpm-'));
  try {
    writeFile(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'apps/*'\n");
    writeFile(join(root, 'packages/core/package.json'), JSON.stringify({ name: '@monorepo/core' }, null, 2));
    writeFile(join(root, 'apps/docs/package.json'), JSON.stringify({ name: '@monorepo/docs' }, null, 2));

    const result = listWorkspacePackages(root);
    assert.deepEqual(result.map((r) => r.relDir).sort(), ['apps/docs', 'packages/core']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspacePackages expands a scoped "packages/@scope/*" glob', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-workspace-scoped-'));
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'monorepo', private: true, workspaces: ['packages/@scope/*'] }, null, 2));
    writeFile(join(root, 'packages/@scope/one/package.json'), JSON.stringify({ name: '@scope/one' }, null, 2));
    writeFile(join(root, 'packages/@scope/two/package.json'), JSON.stringify({ name: '@scope/two' }, null, 2));

    const result = listWorkspacePackages(root);
    assert.deepEqual(result.map((r) => r.relDir).sort(), ['packages/@scope/one', 'packages/@scope/two']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspacePackages removes negated globs (leading "!") from the result', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-workspace-negation-'));
  try {
    writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'monorepo', private: true, workspaces: ['packages/*', '!packages/excluded'] }, null, 2),
    );
    writeFile(join(root, 'packages/keep/package.json'), JSON.stringify({ name: '@monorepo/keep' }, null, 2));
    writeFile(join(root, 'packages/excluded/package.json'), JSON.stringify({ name: '@monorepo/excluded' }, null, 2));

    const result = listWorkspacePackages(root);
    assert.deepEqual(result.map((r) => r.relDir), ['packages/keep']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listWorkspacePackages returns an empty result for a repo with no workspace declarations', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-workspace-none-'));
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'not-a-monorepo' }, null, 2));
    writeFile(join(root, 'src/index.ts'), 'export const x = 1;\n');

    const result = listWorkspacePackages(root);
    assert.deepEqual(result, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace globstar (packages/**/**) matches depth-1 packages, zero-or-more semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-globstar-'));
  try {
    // Chakra's real pnpm-workspace.yaml shape: "packages/**/**" must still
    // match packages/codemod (depth 1) and packages/deep/nested (depth 2).
    writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/**/**\n');
    writeFile(join(root, 'packages', 'codemod', 'package.json'), JSON.stringify({ name: '@t/codemod' }));
    writeFile(join(root, 'packages', 'deep', 'nested', 'package.json'), JSON.stringify({ name: '@t/nested' }));
    const rels = listWorkspacePackages(root).map((p) => p.relDir).sort();
    assert.deepEqual(rels, ['packages/codemod', 'packages/deep/nested']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// OSS field test fixes (Aug 2026): MCP hint redesign (collect-then-award,
// .well-known/mcp, no bare-devDependency false positive), named evidence for
// every awarded surface signal, empty-extract handling, and CHANGELOG*.md
// filename variants.
// ---------------------------------------------------------------------------

test('surface MCP hint ignores a devDependency that merely contains "mcp" (the Storybook addon-mcp false positive) and the warn still fires', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    writeFile(
      join(root, 'packages/components/package.json'),
      JSON.stringify(
        {
          name: '@testkit/components',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: { '.': './dist/index.js', './toggle': './dist/toggle/index.js', './badge': './dist/badge/index.js' },
          devDependencies: { '@storybook/addon-mcp': '^1.0.0' },
        },
        null,
        2,
      ),
    );

    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });
    assert.ok(
      result.findings.some((f) => f.severity === 'warn' && f.message.includes('No MCP server hint found')),
      `expected the MCP warn to still fire despite the Storybook devDependency, got: ${JSON.stringify(result.findings)}`,
    );
    assert.ok(
      !result.findings.some((f) => f.message.startsWith('MCP hint:') || f.message.startsWith('MCP server found')),
      `must not award MCP credit off a bare "@storybook/addon-mcp" devDependency, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface MCP hint awards once off a real workspace packages/mcp package even when the components package also carries the addon-mcp devDependency, naming packages/mcp', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    writeFile(join(root, 'package.json'), JSON.stringify({ name: 'testkit-monorepo', private: true, workspaces: ['packages/*'] }, null, 2));
    writeFile(
      join(root, 'packages/components/package.json'),
      JSON.stringify(
        {
          name: '@testkit/components',
          main: './dist/index.js',
          types: './dist/index.d.ts',
          exports: { '.': './dist/index.js', './toggle': './dist/toggle/index.js', './badge': './dist/badge/index.js' },
          devDependencies: { '@storybook/addon-mcp': '^1.0.0' },
        },
        null,
        2,
      ),
    );
    writeFile(join(root, 'packages/mcp/package.json'), JSON.stringify({ name: '@testkit/mcp' }, null, 2));

    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });
    const mcpFindings = result.findings.filter((f) => f.message.startsWith('MCP server found') || f.message.startsWith('MCP hint:'));
    assert.equal(mcpFindings.length, 1, `expected exactly one MCP finding (awarded once), got: ${JSON.stringify(result.findings)}`);
    assert.ok(mcpFindings[0].message.includes('packages/mcp'), `finding should name packages/mcp, got: ${mcpFindings[0].message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface MCP hint finds a root public/.well-known/mcp file and names it as evidence', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    writeFile(join(root, 'public/.well-known/mcp'), '{"name":"testkit-mcp"}\n');

    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });
    const hit = result.findings.find((f) => f.message.startsWith('MCP hint:'));
    assert.ok(hit, `expected an MCP hint finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(hit!.message.includes('public/.well-known/mcp'), `finding should name public/.well-known/mcp, got: ${hit!.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface skills-dir and editor-rules awards emit named findings', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    writeFile(join(root, '.claude/skills/reviewer/SKILL.md'), '# reviewer\n');
    writeFile(join(root, '.claude/skills/planner/SKILL.md'), '# planner\n');
    writeFile(join(root, '.github/copilot-instructions.md'), '# rules\n');

    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });

    const skillFinding = result.findings.find((f) => f.message.startsWith('Skill bundles found'));
    assert.ok(skillFinding, `expected a named skill-bundles finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(skillFinding!.message.includes('.claude/skills (2 skills)'), `expected a count of 2 skills, got: ${skillFinding!.message}`);

    const editorFinding = result.findings.find((f) => f.message.startsWith('Editor rules found'));
    assert.ok(editorFinding, `expected a named editor-rules finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(editorFinding!.message.includes('.github/copilot-instructions.md'), `finding should name the file, got: ${editorFinding!.message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface treats an empty-extract catalog snapshot as unmeasured: warn finding, no machine-catalog points', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-emptyextract-'));
  const system = 'emptyextractkit';
  try {
    const catalogsDir = join(root, '.audit-data', 'catalogs');
    mkdirSync(catalogsDir, { recursive: true });
    const emptyCatalog: SystemCatalog = {
      system,
      generatedAt: new Date().toISOString(),
      source: { root, commit: 'test', srcHash: 'test' },
      components: [],
      allExports: [],
      allPropsByExport: {},
    };
    writeFileSync(catalogPath(system, catalogsDir), JSON.stringify(emptyCatalog, null, 2));

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_EMPTYEXTRACTKIT_DIR',
      componentsSrc: 'src', // does not exist
      componentsPkg: '@emptyextractkit/components',
      foundationsPkg: '@emptyextractkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir: join(root, 'tokens') });
    const warnFinding = result.findings.find((f) => f.severity === 'warn' && f.message.includes('empty catalog'));
    assert.ok(warnFinding, `expected the empty-extract warn finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(
      !result.findings.some((f) => f.message.startsWith('Machine-readable catalog found')),
      `must not award machine-catalog points on an empty-extract snapshot, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deprecation accepts a CHANGELOG.en-US.md root variant (Ant Design shape) and names it in the finding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-design-system-bench-audit-localechangelog-'));
  const system = 'localechangelogkit';
  try {
    writeFile(join(root, 'CHANGELOG.en-US.md'), '# Changelog\n\n## 1.2.0\n\n- Something.\n');
    writeFile(join(root, 'src/index.ts'), 'export function Widget() { return null; }\n');

    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_LOCALECHANGELOGKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@localechangelogkit/components',
      foundationsPkg: '@localechangelogkit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkDeprecation(system, cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    assert.ok((result.score as number) >= 25, `expected changelog presence credit, got score ${result.score}`);
    const finding = result.findings.find((f) => f.message.includes('CHANGELOG.en-US.md'));
    assert.ok(finding, `expected a finding naming CHANGELOG.en-US.md, got: ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P3: opt-in hosted-surface probes (docsUrl) — offline by default, network
// only ever touched via a local node:http server on 127.0.0.1.
// ---------------------------------------------------------------------------

interface RouteSpec {
  status: number;
  body?: string;
  contentType?: string;
}

/** node:http server on 127.0.0.1 serving fixed routes; also counts every request it receives, for the "offline means zero network" assertion. */
async function startRouteServer(routes: Record<string, RouteSpec>): Promise<{ baseUrl: string; server: Server; requestCount: () => number }> {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    const route = req.url ? routes[req.url] : undefined;
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(route.status, route.contentType ? { 'content-type': route.contentType } : undefined);
    res.end(route.body ?? '');
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind to a port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, requestCount: () => count };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

test('surface awards llms.txt via hosted URL evidence when there is no local file', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  const { baseUrl, server } = await startRouteServer({
    '/llms.txt': { status: 200, body: '# Testkit\n\n- Toggle\n- Stack\n' },
  });
  try {
    cfg.docsUrl = baseUrl;
    const hosted = await probeHostedSurface(baseUrl);
    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir, hosted });
    const evidence = result.findings.find((f) => f.message.includes('llms.txt found at hosted docs URL'));
    assert.ok(evidence, `expected hosted llms.txt evidence, got: ${JSON.stringify(result.findings)}`);
    assert.ok(evidence!.message.includes(`${baseUrl}/llms.txt`), `evidence must name the URL, got: ${evidence!.message}`);
    assert.ok(
      !result.findings.some((f) => f.severity === 'warn' && f.message.startsWith('No llms.txt')),
      'must not also warn about absence once hosted evidence was found',
    );
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface warns when a hosted llms artifact exceeds the 1 MB practical context budget', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  const bigBody = `# Testkit\n${'x'.repeat(1_200_000)}`;
  const { baseUrl, server } = await startRouteServer({
    '/llms.txt': { status: 200, body: bigBody },
  });
  try {
    cfg.docsUrl = baseUrl;
    const hosted = await probeHostedSurface(baseUrl);
    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir, hosted });
    const budgetWarn = result.findings.find((f) => f.severity === 'warn' && f.message.startsWith('llms artifact exceeds practical context budgets'));
    assert.ok(budgetWarn, `expected the context-budget warn, got: ${JSON.stringify(result.findings)}`);
    const sizeInfo = result.findings.find((f) => f.message.includes('llms.txt (hosted') && f.message.includes('MB'));
    assert.ok(sizeInfo, `expected an info finding naming the hosted llms.txt size in MB, got: ${JSON.stringify(result.findings)}`);
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface credits a registry hint found only via hosted /mcp/index.json, naming the URL', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  const { baseUrl, server } = await startRouteServer({
    '/mcp/index.json': { status: 200, body: JSON.stringify({ entries: [{ name: 'Toggle' }] }), contentType: 'application/json' },
  });
  try {
    cfg.docsUrl = baseUrl;
    const hosted = await probeHostedSurface(baseUrl);
    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir, hosted });
    const evidence = result.findings.find((f) => f.message.includes('Registry hint found: hosted'));
    assert.ok(evidence, `expected a hosted registry-hint finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(evidence!.message.includes(`${baseUrl}/mcp/index.json`), `evidence must name the URL, got: ${evidence!.message}`);
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit --offline (offline=true passed to runAuditChecks) skips hosted probing entirely: zero network hits, and surface reports the skip', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  const { baseUrl, server, requestCount } = await startRouteServer({
    '/llms.txt': { status: 200, body: 'irrelevant — must never be fetched' },
  });
  try {
    cfg.docsUrl = baseUrl;
    const checks = await runAuditChecks(system, cfg, { catalogsDir, tokensDir }, true);
    assert.equal(requestCount(), 0, 'offline mode must never touch the network');
    const surface = checks.find((c) => c.id === 'surface')!;
    assert.ok(
      surface.findings.some((f) => f.severity === 'info' && f.message === 'Hosted probes skipped (--offline).'),
      `expected the offline-skip info finding, got: ${JSON.stringify(surface.findings)}`,
    );
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('surface with no docsUrl configured is byte-identical to pre-P3 behavior (plain absence warn, not-probed info, no score change)', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  try {
    assert.equal(cfg.docsUrl, undefined);
    const result = await checkSurface(system, cfg, { catalogsDir, tokensDir });
    assert.ok(
      result.findings.some((f) => f.severity === 'warn' && f.message === 'No llms.txt at the system root.'),
      `expected the plain (pre-P3) absence warn with no "or hosted docs site" suffix, got: ${JSON.stringify(result.findings)}`,
    );
    assert.ok(
      result.findings.some((f) => f.severity === 'info' && f.message === 'Hosted surface not probed (no docsUrl configured).'),
      `expected the not-probed info finding, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveHostedSurface: undefined without docsUrl (regardless of offline), "offline" string when the flag is set, a real probe otherwise', async () => {
  const { cfg, root } = buildSyntheticSystem();
  try {
    assert.equal(cfg.docsUrl, undefined);
    assert.equal(await resolveHostedSurface(cfg, false), undefined);
    assert.equal(await resolveHostedSurface(cfg, true), undefined, 'no docsUrl means offline is moot — still undefined');

    const { baseUrl, server } = await startRouteServer({ '/llms.txt': { status: 200, body: 'ok' } });
    try {
      cfg.docsUrl = baseUrl;
      assert.equal(await resolveHostedSurface(cfg, true), 'offline');
      const hosted = await resolveHostedSurface(cfg, false);
      assert.ok(hosted && typeof hosted === 'object' && hosted.docsUrl === baseUrl, `expected a real HostedSurface, got: ${JSON.stringify(hosted)}`);
    } finally {
      await stopServer(server);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs-greppability computes llms.txt coverage from a hosted probe when there is no local file', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  const { baseUrl, server } = await startRouteServer({
    '/llms.txt': { status: 200, body: '# Testkit\n\n- Toggle\n' }, // names Toggle only, not Stack
  });
  try {
    cfg.docsUrl = baseUrl;
    const hosted = await probeHostedSurface(baseUrl);
    const result = await checkDocsGreppability(system, cfg, { catalogsDir, tokensDir, hosted });
    const evidence = result.findings.find((f) => f.message.startsWith('Hosted llms.txt ('));
    assert.ok(evidence, `expected a hosted-llms-coverage finding, got: ${JSON.stringify(result.findings)}`);
    assert.ok(evidence!.message.includes('1/2 components (50%)'), `expected 1/2 coverage, got: ${evidence!.message}`);
    assert.equal(result.score, 55, `expected 10 (docs exist) + 0.6*50 (md coverage) + 0.3*50 (llms coverage) = 55, got ${result.score}`);
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('docs-greppability treats a hosted llms.txt too large to read as unmeasured, not absent, and renormalizes the score', async () => {
  const { cfg, catalogsDir, tokensDir, system, root } = buildSyntheticSystem();
  const bigBody = `# Testkit\n${'x'.repeat(1_200_000)}`;
  const { baseUrl, server } = await startRouteServer({
    '/llms.txt': { status: 200, body: bigBody },
  });
  try {
    cfg.docsUrl = baseUrl;
    const hosted = await probeHostedSurface(baseUrl);
    // Sanity check on the fixture: text must NOT have been captured (over the 1 MB probe capture limit) — otherwise this test isn't exercising the unmeasured path.
    const llmsProbe = hosted.probes.find((p) => p.path === '/llms.txt');
    assert.equal(llmsProbe?.status, 'found');
    assert.equal(llmsProbe?.text, undefined);

    const result = await checkDocsGreppability(system, cfg, { catalogsDir, tokensDir, hosted });
    assert.ok(
      !result.findings.some((f) => f.severity === 'warn' && f.message.startsWith('No llms.txt found')),
      `must not claim absence for a hosted llms.txt known to exist, got: ${JSON.stringify(result.findings)}`,
    );
    assert.ok(
      result.findings.some((f) => f.severity === 'info' && f.message.includes('coverage unmeasured')),
      `expected an unmeasured-coverage info finding, got: ${JSON.stringify(result.findings)}`,
    );
    // Renormalized over the two measured terms only: (10*100 + 60*50) / 70 = 57.1428... -> 57.1
    assert.equal(result.score, 57.1, `expected the llms term's weight excluded and renormalized, got ${result.score}`);
  } finally {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});
