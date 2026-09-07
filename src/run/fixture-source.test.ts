// 'source' consume-mode fixture template: unit-level coverage for the copy +
// placeholder-substitution steps provisionWorkspace performs against
// fixtures/source-app, deliberately exercised WITHOUT node_modules or a real
// npm install (offline, tmp dirs) — see fixture-npm.test.ts for the analogous
// npm-mode coverage. In particular this proves __COMPONENTS_SRC__ and
// __FOUNDATIONS_CSS__ are filled from the system's own componentsSrc /
// foundationsCss config rather than a hardcoded packages/components/src
// layout, and that a system with no foundationsCss gets a clean template
// (no stray CSS import) instead of a reference to a nonexistent file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyFoundationsCssPlaceholder, copyTemplate, substitutePlaceholders } from './fixture.ts';
import { paths } from '../config.ts';
import type { SystemConfig } from '../types.ts';

const SOURCE_APP_DIR = join(paths.fixturesDir, 'source-app');

function baseSourceConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    root: '/systems/acme-ui',
    rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_ACME_DIR',
    componentsSrc: 'packages/components/src',
    componentsPkg: '@acme/components',
    foundationsPkg: '@acme/foundations',
    foundationsCss: 'packages/foundations/src/index.css',
    catalogStrategy: 'docgen',
    agentContext: { agentsMd: [] },
    ...overrides,
  };
}

/** Stages source-app into a fresh temp dir the way provisionWorkspace does, minus node_modules/git. */
function stageSourceApp(cfg: SystemConfig): string {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-source-app-'));
  copyTemplate(SOURCE_APP_DIR, dir);
  substitutePlaceholders(dir, cfg);
  applyFoundationsCssPlaceholder(dir, cfg);
  return dir;
}

// ---------------------------------------------------------------------------
// Default layout (packages/components/src, foundationsCss set): must stay
// byte-for-byte equivalent to today's hardcoded behavior.
// ---------------------------------------------------------------------------

test('source-app default componentsSrc/foundationsCss layout resolves exactly like the previous hardcoded paths', () => {
  const dir = stageSourceApp(baseSourceConfig());
  try {
    const tsconfig = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    assert.ok(tsconfig.includes('"@acme/components": ["/systems/acme-ui/packages/components/src/index.ts"]'));
    assert.ok(tsconfig.includes('"@acme/components/*": ["/systems/acme-ui/packages/components/src/*"]'));
    assert.ok(tsconfig.includes('"/systems/acme-ui/packages/foundations/src/index.css"'));
    assert.ok(!tsconfig.includes('__COMPONENTS_SRC__'));
    assert.ok(!tsconfig.includes('__FOUNDATIONS_CSS__'));

    const vite = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    assert.ok(vite.includes("replacement: `${SYSTEM_ROOT}/packages/components/src/index.ts`"));
    assert.ok(vite.includes("replacement: `${SYSTEM_ROOT}/packages/components/src/$1`"));
    assert.ok(vite.includes("replacement: `${SYSTEM_ROOT}/packages/foundations/src/index.css`"));

    const main = readFileSync(join(dir, 'src', 'main.tsx'), 'utf8');
    assert.ok(main.includes("import '@acme/foundations/index.css';"));
    assert.ok(!main.includes('__FOUNDATIONS_CSS_ENTRY__'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Non-default layout: the bug this covers. A system whose components live
// somewhere other than packages/components/src must still resolve.
// ---------------------------------------------------------------------------

test('source-app resolves a non-default componentsSrc (e.g. Mantine/Chakra-style layouts)', () => {
  const cfg = baseSourceConfig({ componentsSrc: 'packages/@mantine/core/src' });
  const dir = stageSourceApp(cfg);
  try {
    const tsconfig = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    assert.ok(tsconfig.includes('"@acme/components": ["/systems/acme-ui/packages/@mantine/core/src/index.ts"]'));
    assert.ok(tsconfig.includes('"@acme/components/*": ["/systems/acme-ui/packages/@mantine/core/src/*"]'));
    assert.ok(!tsconfig.includes('packages/components/src'));

    const vite = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    assert.ok(vite.includes("replacement: `${SYSTEM_ROOT}/packages/@mantine/core/src/index.ts`"));
    assert.ok(vite.includes("replacement: `${SYSTEM_ROOT}/packages/@mantine/core/src/$1`"));
    assert.ok(!vite.includes('packages/components/src'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source-app with no foundationsCss drops the CSS import instead of referencing a nonexistent file', () => {
  const cfg = baseSourceConfig({ componentsSrc: 'src', foundationsCss: undefined });
  const dir = stageSourceApp(cfg);
  try {
    const main = readFileSync(join(dir, 'src', 'main.tsx'), 'utf8');
    assert.ok(!main.includes('__FOUNDATIONS_CSS_ENTRY__'));
    assert.ok(!main.includes("import '@acme/foundations"));
    assert.equal(
      main,
      "import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\n\ncreateRoot(document.getElementById('root') as HTMLElement).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n",
    );

    // The now-dead tsconfig/vite aliases stay syntactically valid (harmless,
    // never resolved — nothing imports this specifier any more).
    const tsconfig = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(tsconfig.replace(/\/\/.*$/gm, '')));
    assert.ok(tsconfig.includes('foundations-css-not-configured.css'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
