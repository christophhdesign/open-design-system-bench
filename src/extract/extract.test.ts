// Offline verification of the docgen extractor's barrel-walk against the three
// barrel shapes real design systems actually ship:
//   - `export * from './Dir'` with a dir index.ts
//   - `export { X } from './Dir'` named value re-exports
//   - `export * from './File.Skeleton'` bare .tsx modules carrying JSX
// plus dir indexes named index.tsx, and type-only exports that must not become
// component dirs. Synthetic system in a temp dir; no network, no
// real design-system repos.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { SystemConfig } from '../types.ts';
import { extractDocgenCatalog } from './catalog-docgen.ts';
import { collectBarrelExports, findTsconfigUpward, resolveTsconfigUpward } from './normalize.ts';

function writeSyntheticSystem(): string {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });

  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/components', version: '0.0.0' }));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true, module: 'esnext', moduleResolution: 'bundler' } }),
  );

  writeFileSync(
    join(src, 'index.ts'),
    [
      "export * from './Alpha';", // dir with a re-export-only index.ts
      "export { Beta } from './Beta';", // named value re-export, dir index is index.tsx
      "export type { GammaProps } from './Gamma';", // type-only: never a component dir
      "export * from './Delta.Skeleton';", // bare .tsx file module with JSX + inline declaration
      "export { useThing } from './useThing';", // lowercase value: not a component name
    ].join('\n'),
  );

  mkdirSync(join(src, 'Alpha'));
  writeFileSync(join(src, 'Alpha', 'index.ts'), "export { Alpha } from './Alpha';\nexport type { AlphaProps } from './Alpha';\n");
  writeFileSync(
    join(src, 'Alpha', 'Alpha.tsx'),
    'export interface AlphaProps { label: string }\nexport const Alpha = (props: AlphaProps) => <button>{props.label}</button>;\n',
  );

  mkdirSync(join(src, 'Beta'));
  writeFileSync(join(src, 'Beta', 'index.tsx'), "export * from './Beta';\n");
  writeFileSync(
    join(src, 'Beta', 'Beta.tsx'),
    'export interface BetaProps { tone?: string }\nexport const Beta = (props: BetaProps) => <span>{props.tone}</span>;\n',
  );

  mkdirSync(join(src, 'Gamma'));
  writeFileSync(join(src, 'Gamma', 'index.ts'), "export type { GammaProps } from './Gamma';\n");
  writeFileSync(join(src, 'Gamma', 'Gamma.ts'), 'export interface GammaProps { id: string }\n');

  writeFileSync(join(src, 'Delta.Skeleton.tsx'), 'export const DeltaSkeleton = () => <div className="skeleton" />;\n');
  writeFileSync(join(src, 'useThing.ts'), 'export const useThing = () => 1;\n');

  return root;
}

function makeConfig(root: string): SystemConfig {
  return {
    root,
    rootEnv: 'ODS_EXTRACT_TEST_DIR',
    componentsSrc: 'src',
    componentsPkg: '@test/components',
    foundationsPkg: '@test/components',
    catalogStrategy: 'docgen',
    agentContext: { agentsMd: [] },
  };
}

test('docgen barrel walk handles export-all dirs, named re-exports, index.tsx, and JSX file modules', async () => {
  const root = writeSyntheticSystem();
  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));

  const dirs = catalog.components.map((c) => c.dir).sort();
  assert.deepEqual(dirs, ['Alpha', 'Beta', 'Delta.Skeleton']);

  const displayNames = catalog.components.flatMap((c) => c.exports.map((e) => e.displayName)).sort();
  assert.deepEqual(displayNames, ['Alpha', 'Beta', 'DeltaSkeleton']);

  // Full public API: components plus types and non-component values from the barrel.
  for (const name of ['Alpha', 'AlphaProps', 'Beta', 'DeltaSkeleton', 'GammaProps', 'useThing']) {
    assert.ok(catalog.allExports.includes(name), `allExports should include ${name}`);
  }

  // Type-only and lowercase-value barrel entries never become component dirs.
  assert.ok(!dirs.includes('Gamma'));
  assert.ok(!dirs.includes('useThing'));
});

test('collectBarrelExports survives JSX in barrel-target modules instead of silently dropping them', () => {
  const root = writeSyntheticSystem();
  const names = collectBarrelExports(join(root, 'src', 'index.ts')).map((e) => e.name);
  assert.ok(names.includes('DeltaSkeleton'), 'JSX file module exports must appear');
  assert.ok(names.includes('Alpha'));
});

test('export * and named re-exports of the same dir merge with export * governing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-merge-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'Combo'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/combo' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));
  writeFileSync(join(src, 'index.ts'), "export { Combo } from './Combo';\nexport * from './Combo';\n");
  writeFileSync(join(src, 'Combo', 'index.ts'), "export { Combo, ComboItem } from './Combo';\n");
  writeFileSync(
    join(src, 'Combo', 'Combo.tsx'),
    'export const Combo = () => <div />;\nexport const ComboItem = () => <li />;\n',
  );

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  const combo = catalog.components.find((c) => c.dir === 'Combo');
  assert.ok(combo, 'Combo dir extracted once');
  const names = combo.exports.map((e) => e.displayName).sort();
  assert.deepEqual(names, ['Combo', 'ComboItem'], 'export * widened the set beyond the named specifier');
  assert.equal(catalog.components.filter((c) => c.dir === 'Combo').length, 1, 'no duplicate dir entries');
});

// ---------------------------------------------------------------------------
// Monorepo field-test regressions (Chakra UI / Mantine): tsconfig resolution,
// barrel-of-barrels recursion, NodeNext .js specifiers, outside-srcDir
// re-exports. Verified against the exact line references named in the task.
// ---------------------------------------------------------------------------

test('findTsconfigUpward/resolveTsconfigUpward: monorepo tsconfig two levels above componentsSrc is found', () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-tsconfig-'));
  // componentsSrc = packages/react/src; tsconfig.json lives at packages/ —
  // two directory levels above src (src -> react -> packages).
  const srcDir = join(root, 'packages', 'react', 'src');
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(root, 'packages', 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  const found = findTsconfigUpward(srcDir, root);
  assert.equal(found, join(root, 'packages', 'tsconfig.json'));
  assert.equal(resolveTsconfigUpward(srcDir, root), found);
});

test('findTsconfigUpward/resolveTsconfigUpward: no tsconfig anywhere in range throws an actionable Error', () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-tsconfig-missing-'));
  const srcDir = join(root, 'packages', 'react', 'src');
  mkdirSync(srcDir, { recursive: true });

  assert.equal(findTsconfigUpward(srcDir, root), undefined);
  assert.throws(
    () => resolveTsconfigUpward(srcDir, root),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /no tsconfig\.json found between/);
      assert.ok(err.message.includes(srcDir), 'message names the searched start');
      assert.ok(err.message.includes(root), 'message names the searched range end');
      return true;
    },
  );
});

test('docgen barrel walk follows export * chains through a barrel-of-barrels, with NodeNext .js specifiers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-nested-barrel-'));
  const src = join(root, 'src');
  const componentsDir = join(src, 'components');
  mkdirSync(componentsDir, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/nested' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  // Root barrel only re-exports a single aggregator dir, using a NodeNext-style
  // '.js' specifier extension on the barrel-of-barrels itself.
  writeFileSync(join(src, 'index.ts'), "export * from './components/index.js';\n");
  // The aggregator: no inline components of its own, just further export *
  // chains to each real component directory.
  writeFileSync(join(componentsDir, 'index.ts'), "export * from './One';\nexport * from './Two';\n");

  mkdirSync(join(componentsDir, 'One'));
  writeFileSync(join(componentsDir, 'One', 'index.ts'), "export * from './One';\n");
  writeFileSync(join(componentsDir, 'One', 'One.tsx'), 'export const One = () => <button>one</button>;\n');

  mkdirSync(join(componentsDir, 'Two'));
  writeFileSync(join(componentsDir, 'Two', 'index.ts'), "export * from './Two';\n");
  writeFileSync(join(componentsDir, 'Two', 'Two.tsx'), 'export const Two = () => <button>two</button>;\n');

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));

  const dirs = catalog.components.map((c) => c.dir).sort();
  assert.deepEqual(dirs, ['components/One', 'components/Two'], 'aggregator itself is not a dir; its reachable leaves are');

  const names = catalog.components.flatMap((c) => c.exports.map((e) => e.displayName)).sort();
  assert.deepEqual(names, ['One', 'Two']);
});

test('resolveReexportTarget resolves a .js-suffixed direct named re-export (export { Foo } from "./foo/index.js")', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-js-named-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'foo'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/js-named' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  writeFileSync(join(src, 'index.ts'), "export { Foo } from './foo/index.js';\n");
  writeFileSync(join(src, 'foo', 'index.tsx'), 'export const Foo = () => <div />;\n');

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));

  assert.ok(catalog.components.some((c) => c.dir === 'foo'), 'the .js-suffixed named re-export resolved to a dir');
  const names = catalog.components.flatMap((c) => c.exports.map((e) => e.displayName));
  assert.ok(names.includes('Foo'));
});

test('a re-export resolving outside componentsSrc but inside the system root is followed, not dropped', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-outside-srcdir-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(root + '/package.json', JSON.stringify({ name: '@test/outside' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  // Box lives in a sibling 'shared' dir outside componentsSrc ('src') but
  // still inside the system root — mirrors the Mantine field-test bug where
  // Box lives outside the components dir but is still exported by the barrel.
  mkdirSync(join(root, 'shared', 'Box'), { recursive: true });
  writeFileSync(join(root, 'shared', 'Box', 'index.ts'), "export { Box } from './Box';\n");
  writeFileSync(join(root, 'shared', 'Box', 'Box.tsx'), 'export const Box = () => <div />;\n');

  writeFileSync(join(src, 'index.ts'), "export * from '../shared/Box';\n");

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));

  // Chosen option for the outside-srcDir case: follow it (as long as it
  // stays inside the system root) rather than only warning about it, so the
  // component is not silently missing from the catalog.
  assert.ok(catalog.allExports.includes('Box'), 'Box is present in allExports despite living outside componentsSrc');
  const boxComponent = catalog.components.find((c) => c.exports.some((e) => e.displayName === 'Box'));
  assert.ok(boxComponent, 'Box has a full catalog component entry (not just an allExports stub)');
});

test('a direct-file NodeNext specifier (export { X } from "./Button.js") resolves to the .tsx source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-js-directfile-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/js-directfile' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  // No /index.js segment: the specifier names the implementation file itself
  // with a NodeNext .js extension. Stripping must leave a bare base so the
  // resolver's own .ts/.tsx candidates can match Button.tsx.
  writeFileSync(join(src, 'index.ts'), "export { Button } from './Button.js';\nexport * from './helpers.js';\n");
  writeFileSync(join(src, 'Button.tsx'), 'export const Button = () => <button />;\n');
  writeFileSync(join(src, 'helpers.tsx'), 'export const HelperBadge = () => <em />;\n');

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  const names = catalog.components.flatMap((c) => c.exports.map((e) => e.displayName));
  assert.ok(names.includes('Button'), `Button missing from ${JSON.stringify(names)}`);
  assert.ok(catalog.allExports.includes('Button'), 'Button missing from allExports');
  assert.ok(catalog.allExports.includes('HelperBadge'), 'export * with a direct-file .js specifier missing from allExports');
});
