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
const CUSTOM_ELEMENTS_APP_DIR = join(paths.fixturesDir, 'custom-elements-app');

/**
 * The alias entries a substituted vite.config.ts actually produces.
 *
 * Evaluated rather than pattern-matched, because the two bugs this guards
 * against are both invisible to a text assertion: a scoped componentsPkg
 * substituted into a regex LITERAL closes it early and makes the whole file
 * unparseable, and an alias list in the wrong order resolves the wrong entry
 * while looking perfectly correct. The config's own imports are stubbed so
 * this stays offline and needs no fixture node_modules.
 */
function evalViteAliases(dir: string): { find: string | RegExp; replacement: string }[] {
  const body = readFileSync(join(dir, 'vite.config.ts'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace('export default ', 'return ');
  const stub = () => ({});
  const config = new Function('defineConfig', 'react', 'tailwindcss', body)(
    (c: unknown) => c,
    stub,
    stub,
  ) as { resolve: { alias: { find: string | RegExp; replacement: string }[] } };
  return config.resolve.alias;
}

/**
 * Vite's own alias matching, from @rollup/plugin-alias. Reproduced here
 * because the prefix rule on the last line is the whole point: a string
 * `find` of '@acme/components' also matches '@acme/components/button', so
 * entry order decides which one a deep import gets.
 */
function matchesAlias(pattern: string | RegExp, importee: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(importee);
  if (importee.length < pattern.length) return false;
  if (importee === pattern) return true;
  return importee.startsWith(`${pattern}/`);
}

/** First matching alias applied to `importee`, or undefined when none matches. */
function resolveAlias(dir: string, importee: string): string | undefined {
  for (const { find, replacement } of evalViteAliases(dir)) {
    if (!matchesAlias(find, importee)) continue;
    return find instanceof RegExp ? importee.replace(find, replacement) : importee.replace(find, replacement);
  }
  return undefined;
}

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

test('source-app aliases a single-entry foundationsCss list exactly like the bare string', () => {
  const dir = stageSourceApp(baseSourceConfig({ foundationsCss: ['packages/foundations/src/index.css'] }));
  try {
    const tsconfig = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    assert.ok(tsconfig.includes('"/systems/acme-ui/packages/foundations/src/index.css"'));
    const main = readFileSync(join(dir, 'src', 'main.tsx'), 'utf8');
    assert.ok(main.includes("import '@acme/foundations/index.css';"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source-app drops the CSS import, warning, when foundationsCss names several files', () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(' '));
  };
  const cfg = baseSourceConfig({
    foundationsCss: ['packages/tokens/css/palette.css', 'packages/tokens/css/spacing.css'],
  });
  let dir: string | undefined;
  try {
    dir = stageSourceApp(cfg);
    // The alias resolves one path or none. Aliasing the first file would
    // style the fixture with the palette and silently without the rest.
    const main = readFileSync(join(dir, 'src', 'main.tsx'), 'utf8');
    assert.ok(!main.includes('__FOUNDATIONS_CSS_ENTRY__'));
    assert.ok(!main.includes("import '@acme/foundations"));

    const tsconfig = readFileSync(join(dir, 'tsconfig.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(tsconfig.replace(/\/\/.*$/gm, '')));
    assert.ok(tsconfig.includes('foundations-css-not-configured.css'));
    assert.ok(!tsconfig.includes('palette.css'), 'must not silently alias the first file of the list');

    assert.ok(
      warnings.some((w) => w.includes('foundationsCss names 2 files')),
      `an unstyled workspace must say why, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = realWarn;
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Vite alias resolution. The tsconfig side of the same aliases is plain JSON
// and has always been correct, which is why this went unnoticed: `compile`
// grades through tsc, so a broken vite.config.ts costs the fixture its dev
// server and build, not its score.
// ---------------------------------------------------------------------------

test('source-app vite config parses after substitution, with a scoped componentsPkg', () => {
  // Guards the obvious repair of the bug below, which is worse than the bug:
  // writing the pattern as the literal `/^__COMPONENTS_PKG__\/(.*)$/` puts a
  // scoped package's slash inside a regex literal, closing it early, and node
  // rejects the whole file with "SyntaxError: Invalid regular expression
  // flags". Nearly every real componentsPkg is scoped, so that would be the
  // normal case rather than an edge one.
  const dir = stageSourceApp(baseSourceConfig());
  try {
    assert.doesNotThrow(() => evalViteAliases(dir));
    const vite = readFileSync(join(dir, 'vite.config.ts'), 'utf8');
    assert.ok(!vite.includes('__COMPONENTS_PKG__'), 'placeholder must be fully substituted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source-app aliases a deep import at the component, not through the barrel', () => {
  // The bug, on two counts. The subpath pattern was left as scrubbed
  // placeholder prose, `/^@the design system\/components\/(.*)$/`, so it
  // matched no package any system could declare. And it would never have been
  // reached anyway: the barrel entry came first as a bare string, which
  // matches the whole prefix, so '@acme/components/button' resolved to
  // '<src>/index.ts/button' — a path that cannot exist.
  const dir = stageSourceApp(baseSourceConfig());
  try {
    assert.equal(
      resolveAlias(dir, '@acme/components/button'),
      '/systems/acme-ui/packages/components/src/button',
    );
    assert.equal(
      resolveAlias(dir, '@acme/components'),
      '/systems/acme-ui/packages/components/src/index.ts',
    );
    // A nested subpath keeps its whole tail.
    assert.equal(
      resolveAlias(dir, '@acme/components/forms/text-field'),
      '/systems/acme-ui/packages/components/src/forms/text-field',
    );
    // A package that merely starts with the same characters is not ours.
    assert.equal(resolveAlias(dir, '@acme/components-legacy'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source-app alias patterns survive a componentsPkg containing regex metacharacters', () => {
  const cfg = baseSourceConfig({ componentsPkg: '@acme/ui.core+web', componentsSrc: 'src' });
  const dir = stageSourceApp(cfg);
  try {
    assert.equal(resolveAlias(dir, '@acme/ui.core+web/button'), '/systems/acme-ui/src/button');
    // Unescaped, '.' and '+' would let a different package match.
    assert.equal(resolveAlias(dir, '@acme/uixcorexweb/button'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('custom-elements-app resolves the same two alias shapes', () => {
  const cfg = baseSourceConfig({ componentModel: 'custom-elements', componentsSrc: 'src' });
  const dir = mkdtempSync(join(tmpdir(), 'odsys-ce-app-'));
  try {
    copyTemplate(CUSTOM_ELEMENTS_APP_DIR, dir);
    substitutePlaceholders(dir, cfg);
    assert.equal(resolveAlias(dir, '@acme/components'), '/systems/acme-ui/src/index.ts');
    assert.equal(resolveAlias(dir, '@acme/components/loader'), '/systems/acme-ui/src/loader');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
