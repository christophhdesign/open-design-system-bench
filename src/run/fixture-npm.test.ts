// npm-consume fixture mode: unit-level coverage for the copy + placeholder
// steps prepareTemplate's 'npm' branch performs, deliberately exercised
// WITHOUT a real `npm install` (offline, tmp dirs) — see fixture.test.ts-style
// siblings for the rest of the fixture lifecycle. The one real end-to-end npm
// install (against @radix-ui/react-slot) is a separate, manually-run
// verification, not part of this offline suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyCssEntryPlaceholder, preparedNpmDir, stageNpmTemplate, templateDir } from './fixture.ts';
import type { SystemConfig } from '../types.ts';

function baseNpmConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    root: '/tmp/does-not-need-to-exist-for-these-checks',
    rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_ACME_DIR',
    componentsSrc: 'src',
    componentsPkg: '@acme/ui',
    foundationsPkg: '@acme/ui',
    catalogStrategy: 'docgen',
    agentContext: { agentsMd: [] },
    consume: 'npm',
    packageSpec: '@acme/ui',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyCssEntryPlaceholder
// ---------------------------------------------------------------------------

test('applyCssEntryPlaceholder removes the placeholder import line when cssEntry is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-css-entry-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'main.tsx'),
      "import { StrictMode } from 'react';\nimport '__CSS_ENTRY__';\nimport App from './App';\n",
    );
    applyCssEntryPlaceholder(dir, undefined);
    const content = readFileSync(join(dir, 'src', 'main.tsx'), 'utf8');
    assert.ok(!content.includes('__CSS_ENTRY__'));
    assert.equal(content, "import { StrictMode } from 'react';\nimport App from './App';\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyCssEntryPlaceholder rewrites the placeholder to the real import when cssEntry is set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-css-entry-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'main.tsx'), "import '__CSS_ENTRY__';\n");
    applyCssEntryPlaceholder(dir, '@acme/ui/styles.css');
    assert.equal(readFileSync(join(dir, 'src', 'main.tsx'), 'utf8'), "import '@acme/ui/styles.css';\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyCssEntryPlaceholder is a no-op when main.tsx has no placeholder (source-mode templates)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-css-entry-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    const original = "import '@acme-ui/foundations/index.css';\n";
    writeFileSync(join(dir, 'src', 'main.tsx'), original);
    applyCssEntryPlaceholder(dir, '@acme/ui/styles.css');
    assert.equal(readFileSync(join(dir, 'src', 'main.tsx'), 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyCssEntryPlaceholder is a no-op when main.tsx does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-css-entry-'));
  try {
    assert.doesNotThrow(() => applyCssEntryPlaceholder(dir, '@acme/ui/styles.css'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// templateDir routing
// ---------------------------------------------------------------------------

test('templateDir routes npm-consume systems to fixtures/.prepared/<id>-app', () => {
  const dir = templateDir('acme', baseNpmConfig());
  assert.equal(dir, preparedNpmDir('acme'));
  assert.match(dir, /fixtures[\\/]\.prepared[\\/]acme-app$/);
});

test('templateDir falls back to the generic source template when a system has no hand-rolled one', () => {
  const cfg: SystemConfig = {
    root: '/tmp/whatever',
    rootEnv: 'X',
    componentsSrc: 'src',
    componentsPkg: '@acme/ui',
    foundationsPkg: '@acme/ui',
    catalogStrategy: 'docgen',
    agentContext: { agentsMd: [] },
  };
  // No fixtures/acme-app exists, so source mode resolves to the generic
  // template. This is what makes a fresh system work without hand-rolling a
  // fixture; the placeholders inside it are filled from the system's config.
  const dir = templateDir('acme', cfg);
  assert.match(dir, /fixtures[\\/]source-app$/);
  assert.ok(!dir.includes('.prepared'));
});

test('templateDir honors fixtureTemplate override in source mode (unaffected by npm-mode routing)', () => {
  const cfg: SystemConfig = {
    root: '/tmp/whatever',
    rootEnv: 'X',
    componentsSrc: 'src',
    componentsPkg: '@acme/ui',
    foundationsPkg: '@acme/ui',
    catalogStrategy: 'docgen',
    agentContext: { agentsMd: [] },
    fixtureTemplate: 'fixtures/systemA-app',
  };
  const dir = templateDir('acme', cfg);
  assert.match(dir, /fixtures[\\/]systemA-app$/);
});

// ---------------------------------------------------------------------------
// stageNpmTemplate: copy + placeholder handling, no npm install
// ---------------------------------------------------------------------------

test('stageNpmTemplate copies the generic npm-app template and bakes in cssEntry, without installing', () => {
  const system = '__odb_test_npm_fixture_css__';
  const dest = preparedNpmDir(system);
  try {
    const cfg = baseNpmConfig({ cssEntry: '@acme/ui/styles.css' });
    const result = stageNpmTemplate(system, cfg);

    assert.equal(result, dest);
    assert.ok(existsSync(join(dest, 'package.json')), 'expected package.json to be copied');
    assert.ok(existsSync(join(dest, 'src', 'main.tsx')), 'expected src/main.tsx to be copied');
    assert.ok(!existsSync(join(dest, 'node_modules')), 'no npm install should have run');

    const main = readFileSync(join(dest, 'src', 'main.tsx'), 'utf8');
    assert.ok(main.includes("import '@acme/ui/styles.css';"));
    assert.ok(!main.includes('__CSS_ENTRY__'));

    // package.json must not name the DS as a dependency — it's installed
    // separately by prepareTemplate's second npm install step.
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.ok(!('@acme/ui' in (pkg.dependencies ?? {})));
    assert.ok(!('@acme/ui' in (pkg.devDependencies ?? {})));
    assert.ok('react' in (pkg.dependencies ?? {}));
    assert.ok('vite' in (pkg.devDependencies ?? {}));
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('stageNpmTemplate removes the cssEntry placeholder line entirely when cssEntry is absent', () => {
  const system = '__odb_test_npm_fixture_nocss__';
  const dest = preparedNpmDir(system);
  try {
    const cfg = baseNpmConfig();
    delete (cfg as { cssEntry?: string }).cssEntry;
    stageNpmTemplate(system, cfg);
    const main = readFileSync(join(dest, 'src', 'main.tsx'), 'utf8');
    assert.ok(!main.includes('__CSS_ENTRY__'));
    assert.ok(!main.includes("import '';"));
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test('stageNpmTemplate tsconfig has no design-system path aliases', () => {
  const system = '__odb_test_npm_fixture_tsconfig__';
  const dest = preparedNpmDir(system);
  try {
    stageNpmTemplate(system, baseNpmConfig());
    const tsconfig = readFileSync(join(dest, 'tsconfig.json'), 'utf8');
    assert.ok(!tsconfig.includes('__SYSTEM_ROOT__'));
    assert.ok(!tsconfig.includes('"paths"'));
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});
