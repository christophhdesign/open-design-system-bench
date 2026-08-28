// Tests for the tokens check's zero-path partial credit (plan 3.5 + 5.3):
// SCSS pre-build tokens and TS-defined token systems that are detectable but
// not statically machine-readable. A separate file from audit.test.ts (which
// another agent owns concurrently), following the pattern in
// catalog-quality.test.ts of exercising one check directly against a
// synthetic temp-dir fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SystemConfig } from '../types.ts';
import { checkTokens } from './checks/tokens.ts';
import type { AuditDirs } from './types.ts';

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

/** Minimal SystemConfig for a fresh temp root, with no foundationsCss (the zero-path trigger) unless overridden. */
function baseConfig(root: string, overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    root,
    rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_TOKENS_CHECK_TEST_DIR',
    componentsSrc: 'src', // does not need to exist; the ts-token search widens to its parent (root)
    componentsPkg: '@testkit/components',
    foundationsPkg: '@testkit/foundations',
    catalogStrategy: 'docgen',
    agentContext: { agentsMd: [] },
    ...overrides,
  };
}

/** No pre-extracted catalog/tokens snapshot on disk — dirs simply don't exist, matching the zero-path precondition. */
function emptyDirs(root: string): AuditDirs {
  return { catalogsDir: join(root, 'catalogs'), tokensDir: join(root, 'tokens') };
}

/** 15 `--cds-*` custom-property declarations plus a data-theme dark block — the Carbon-style pre-build shape. */
function writeScssFixture(root: string, relPath: string): void {
  const decls = Array.from({ length: 15 }, (_, i) => `  --cds-color-${i}: #${(i + 1).toString(16).padStart(3, '0')};`).join('\n');
  writeFile(
    join(root, relPath),
    // The dark block deliberately assigns a plain CSS property (not another
    // custom-property declaration) so it contributes the dark signal without
    // shifting the declaration count above the fixture's intended 15.
    ['.foundation {', decls, '}', '', '[data-theme="dark"] {', '  color: black;', '}'].join('\n'),
  );
}

test('SCSS-only system: partial credit, names the densest file, dark signal awarded, score capped well below full credit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-tokens-scss-'));
  try {
    writeScssFixture(root, 'packages/styles/foo.scss');
    const cfg = baseConfig(root);
    const result = await checkTokens('scsskit', cfg, emptyDirs(root));

    assert.ok(result.score !== null && result.score > 0, `expected partial credit, got score ${result.score}`);
    assert.ok((result.score as number) <= 45, `expected score <= 45 (the partial-credit cap), got ${result.score}`);

    const scssFinding = result.findings.find((f) => f.message.includes('CSS custom property declarations found in .scss sources'));
    assert.ok(scssFinding, `expected an scss-detection finding, got: ${JSON.stringify(result.findings)}`);
    assert.match(scssFinding!.message, /15 CSS custom property declarations/);
    assert.match(scssFinding!.message, /packages[\\/]styles[\\/]foo\.scss/);

    const darkFinding = result.findings.find((f) => f.message.includes('Light/dark theming signal found in .scss sources'));
    assert.ok(darkFinding, `expected the scss dark-signal finding to be awarded, got: ${JSON.stringify(result.findings)}`);

    assert.ok(
      !result.findings.some((f) => f.severity === 'fail'),
      `expected no fail finding once partial credit is awarded, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TS-token system: partial credit, names the file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-tokens-ts-'));
  try {
    writeFile(
      join(root, 'theme/tokens.ts'),
      [
        "import { defineSemanticTokens } from '@chakra-ui/react';",
        '',
        'export const colors = defineSemanticTokens({',
        "  brand: { value: { base: '{colors.blue.500}' } },",
        '});',
      ].join('\n'),
    );
    const cfg = baseConfig(root);
    const result = await checkTokens('tskit', cfg, emptyDirs(root));

    assert.ok(result.score !== null && result.score > 0, `expected partial credit, got score ${result.score}`);

    const tsFinding = result.findings.find((f) => f.message.includes('TS-defined token system found'));
    assert.ok(tsFinding, `expected a ts-token-detection finding, got: ${JSON.stringify(result.findings)}`);
    assert.match(tsFinding!.message, /theme[\\/]tokens\.ts/);

    assert.ok(
      !result.findings.some((f) => f.severity === 'fail'),
      `expected no fail finding once partial credit is awarded, got: ${JSON.stringify(result.findings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SCSS + TS together: combined partial score is capped at 45', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-tokens-both-'));
  try {
    writeScssFixture(root, 'packages/styles/foo.scss');
    writeFile(
      join(root, 'theme/tokens.ts'),
      ["import { createTheme } from '@mui/material/styles';", '', 'export const theme = createTheme({});'].join('\n'),
    );
    const cfg = baseConfig(root);
    const result = await checkTokens('bothkit', cfg, emptyDirs(root));

    assert.equal(result.score, 45, `expected the combined SCSS(20)+dark(15)+TS(20)=55 score capped at 45, got ${result.score}`);

    assert.ok(result.findings.some((f) => f.message.includes('CSS custom property declarations found in .scss sources')));
    assert.ok(result.findings.some((f) => f.message.includes('Light/dark theming signal found in .scss sources')));
    assert.ok(result.findings.some((f) => f.message.includes('TS-defined token system found')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('neither SCSS nor TS tokens: score 0, unchanged fail finding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-tokens-none-'));
  try {
    const cfg = baseConfig(root);
    const result = await checkTokens('nonekit', cfg, emptyDirs(root));

    assert.equal(result.score, 0);
    const failFinding = result.findings.find((f) => f.severity === 'fail');
    assert.ok(failFinding, `expected the fail finding, got: ${JSON.stringify(result.findings)}`);
    assert.equal(failFinding!.message, 'No foundationsCss configured and no extracted tokens snapshot found.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real foundationsCss system still earns more than the capped partial score', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-tokens-real-'));
  try {
    // 30 vars (full "presence" credit), half referencing another var (a
    // real semantic layer), plus a dark-mode signal — the full-credit path
    // this check has always supported.
    const primitiveLines = Array.from({ length: 15 }, (_, i) => `  --color-blue-${i}: #${(i + 1).toString(16).padStart(3, '0')};`);
    const semanticLines = Array.from({ length: 15 }, (_, i) => `  --color-text-${i}: var(--color-blue-${i});`);
    writeFile(
      join(root, 'foundations/index.css'),
      [':root {', ...primitiveLines, ...semanticLines, '}', '', '[data-theme="dark"] {', '  --color-blue-0: #000;', '}'].join('\n'),
    );
    const cfg = baseConfig(root, { foundationsCss: 'foundations/index.css' });
    const realResult = await checkTokens('realkit', cfg, emptyDirs(root));

    // And the capped partial fixture, for a direct side-by-side comparison.
    const partialRoot = mkdtempSync(join(tmpdir(), 'odsys-tokens-real-partial-'));
    try {
      writeScssFixture(partialRoot, 'packages/styles/foo.scss');
      writeFile(
        join(partialRoot, 'theme/tokens.ts'),
        ["import { createTheme } from '@mui/material/styles';", '', 'export const theme = createTheme({});'].join('\n'),
      );
      const partialResult = await checkTokens('partialkit', baseConfig(partialRoot), emptyDirs(partialRoot));

      assert.ok(realResult.score !== null && partialResult.score !== null);
      assert.ok(
        (realResult.score as number) > (partialResult.score as number),
        `expected the real CSS-backed system (${realResult.score}) to outscore the capped partial system (${partialResult.score})`,
      );
      assert.ok((realResult.score as number) > 45, `expected the real system to clear the 45 partial-credit cap, got ${realResult.score}`);
    } finally {
      rmSync(partialRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a plain semanticTokens object declaration counts as a TS token system (Chakra theme shape)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-tokens-semobj-'));
  try {
    mkdirSync(join(root, 'src', 'theme'), { recursive: true });
    writeFileSync(join(root, 'src', 'theme', 'index.ts'), 'export const semanticTokens = { colors: { bg: { value: "{colors.white}" } } };\n');
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_SEMOBJ_DIR',
      componentsSrc: 'src',
      componentsPkg: '@t/c',
      foundationsPkg: '@t/f',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkTokens('semobj', cfg, { catalogsDir: join(root, 'c'), tokensDir: join(root, 't') });
    assert.ok((result.score ?? 0) >= 20, `expected TS partial credit, got ${result.score}: ${JSON.stringify(result.findings)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
