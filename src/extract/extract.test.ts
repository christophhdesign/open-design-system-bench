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
import { collectBarrelExports } from './normalize.ts';

function writeSyntheticSystem(): string {
  const root = mkdtempSync(join(tmpdir(), 'ods-extract-'));
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
  const root = mkdtempSync(join(tmpdir(), 'ods-extract-merge-'));
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
