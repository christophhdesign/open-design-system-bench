// Offline verification of the docgen extractor's barrel-walk against the three
// barrel shapes real design systems actually ship:
//   - `export * from './Dir'` with a dir index.ts
//   - `export { X } from './Dir'` named value re-exports
//   - `export * from './File.Skeleton'` bare .tsx modules carrying JSX
// plus dir indexes named index.tsx, and type-only exports that must not become
// component dirs. Synthetic system in a temp dir; no network, no
// real design-system repos.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { SystemConfig } from '../types.ts';
import { extractDocgenCatalog, splitOwnInherited } from './catalog-docgen.ts';
import { collectBarrelExports, findTsconfigUpward, resolveBarrelPath, resolveTsconfigUpward } from './normalize.ts';

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

// ---------------------------------------------------------------------------
// Own vs. inherited props (Phase 2 item 2.3): a prop declared outside the
// system's componentsSrc tree (styled-system spreads, polymorphic factory
// types, DOM intersections) must contribute only its name, not a full
// CatalogProp, while still counting toward allPropsByExport so the
// apiFidelity invented-prop check (which keys off allPropsByExport) sees no
// difference.
// ---------------------------------------------------------------------------

test('own props keep full metadata; props from a type declared outside componentsSrc become name-only inheritedProps', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-inherited-props-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'Widget'), { recursive: true });
  mkdirSync(join(root, 'shared'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/inherited-props' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  // A type declared in a sibling dir outside componentsSrc ('src') but still
  // inside the system root — the styled-system-spread / DOM-intersection
  // shape this feature exists for.
  writeFileSync(join(root, 'shared', 'style-props.ts'), 'export interface StyleProps { m?: string; p?: string }\n');

  writeFileSync(join(src, 'index.ts'), "export * from './Widget';\n");
  writeFileSync(join(src, 'Widget', 'index.ts'), "export * from './Widget';\n");
  writeFileSync(
    join(src, 'Widget', 'Widget.tsx'),
    [
      "import type { StyleProps } from '../../shared/style-props';",
      'export interface WidgetOwnProps { label: string }',
      'export type WidgetProps = WidgetOwnProps & StyleProps;',
      'export const Widget = (props: WidgetProps) => <div>{props.label}</div>;',
      '',
    ].join('\n'),
  );

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  const widget = catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Widget');
  assert.ok(widget, 'Widget export extracted');

  const ownNames = widget!.props.map((p) => p.name).sort();
  assert.deepEqual(ownNames, ['label'], 'own prop table only carries the in-tree prop');
  const labelProp = widget!.props.find((p) => p.name === 'label');
  assert.equal(labelProp?.type, 'string', 'own prop keeps full CatalogProp metadata');

  assert.deepEqual(widget!.inheritedProps, ['m', 'p'], 'externally-declared props are recorded name-only, sorted');
  assert.ok(
    !widget!.props.some((p) => p.name === 'm' || p.name === 'p'),
    'inherited prop names must not also appear in the own props array',
  );

  const allowed = new Set(catalog.allPropsByExport.Widget);
  assert.ok(allowed.has('label') && allowed.has('m') && allowed.has('p'), 'allPropsByExport merges own and inherited names — the apiFidelity grading contract this change must not break');
});

test('a component with no inherited props gets no inheritedProps field', async () => {
  const root = writeSyntheticSystem(); // Alpha's props (label: string) are declared entirely in-tree
  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  const alpha = catalog.components.flatMap((c) => c.exports).find((e) => e.displayName === 'Alpha');
  assert.ok(alpha, 'Alpha export extracted');
  assert.equal(alpha!.inheritedProps, undefined, 'no inherited props means the field is omitted entirely, not an empty array');
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

test('splitOwnInherited: a parent type shared across >= threshold exports is inherited even inside componentsSrc', () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-split-shared-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'styles'), { recursive: true });
  // The shared type genuinely lives INSIDE componentsSrc (the Chakra v3
  // shape: generated style props under src/styled-system/).
  const sharedFile = join(src, 'styles', 'system.gen.ts');
  writeFileSync(sharedFile, 'export interface SystemProps { m?: string }\n');
  const ownFile = join(src, 'button.tsx');
  writeFileSync(ownFile, 'export {}\n');

  const mkProp = (name: string, parentFile: string | undefined, parentName = 'SystemProps') =>
    ({ name, type: { name: 'string' }, required: false, description: '', ...(parentFile ? { parent: { fileName: parentFile, name: parentName } } : {}) }) as unknown as import('react-docgen-typescript').PropItem;

  const sharedProp = mkProp('m', sharedFile);
  const ownProp = mkProp('variant', ownFile, 'ButtonProps');
  const inlineProp = mkProp('size', undefined);

  // Tally says SystemProps feeds 25 distinct exports; ButtonProps feeds 1.
  const tally = new Map<string, number>([
    [`${sharedFile}#SystemProps`, 25],
    [`${ownFile}#ButtonProps`, 1],
  ]);

  const { own, inheritedNames } = splitOwnInherited([sharedProp, ownProp, inlineProp], src, tally, 20);
  assert.deepEqual(inheritedNames, ['m'], 'shared in-tree parent must classify as inherited');
  assert.deepEqual(own.map((p) => p.name).sort(), ['size', 'variant'], 'component-local and inline props stay own');

  // Below the threshold the same in-tree parent is own.
  const small = splitOwnInherited([sharedProp], src, new Map([[`${sharedFile}#SystemProps`, 3]]), 20);
  assert.equal(small.own.length, 1);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// OSS field-test regressions round 2 (Primer, MUI): tolerating an unknown
// tsconfig compiler option from a newer TypeScript than this bench bundles,
// and accepting a .js/.d.ts (rather than .ts) barrel entry point.
// ---------------------------------------------------------------------------

test('docgen extraction tolerates an unknown/future tsconfig compiler option instead of hard-failing on version skew', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-tsconfig-future-option-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'Button'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/future-tsconfig' }));
  // "stableTypeOrdering" is Primer's real-world trigger (a TS 6.0 option; the
  // bench bundles TS 5.9.3) — a made-up name serves just as well since the
  // point is that ANY unrecognized compilerOptions key must not hard-fail.
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true, someFutureOption2030: true } }),
  );
  writeFileSync(join(src, 'index.ts'), "export * from './Button';\n");
  writeFileSync(join(src, 'Button', 'index.ts'), "export * from './Button';\n");
  writeFileSync(join(src, 'Button', 'Button.tsx'), 'export const Button = () => <button />;\n');

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  const names = catalog.components.flatMap((c) => c.exports.map((e) => e.displayName));
  assert.ok(names.includes('Button'), 'extraction proceeded past the unknown compiler option');
});

test('a genuinely malformed tsconfig.json still fails extraction with a clear, actionable message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-tsconfig-malformed-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/malformed-tsconfig' }));
  writeFileSync(join(root, 'tsconfig.json'), 'not json at all {{{');
  writeFileSync(join(src, 'index.ts'), 'export {};\n');

  await assert.rejects(
    () => extractDocgenCatalog('synthetic', makeConfig(root)),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /tsconfig\.json/);
      return true;
    },
  );
});

test('resolveBarrelPath tries index.ts, .tsx, .js, .jsx, .d.ts in that order and undefined when none exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-resolve-barrel-'));
  const empty = join(root, 'empty');
  mkdirSync(empty, { recursive: true });
  assert.equal(resolveBarrelPath(empty), undefined);

  const jsOnly = join(root, 'js-only');
  mkdirSync(jsOnly, { recursive: true });
  writeFileSync(join(jsOnly, 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(jsOnly, 'index.d.ts'), 'export {};\n');
  assert.equal(resolveBarrelPath(jsOnly), join(jsOnly, 'index.js'), 'index.js is preferred over index.d.ts');

  const tsOnly = join(root, 'ts-only');
  mkdirSync(tsOnly, { recursive: true });
  writeFileSync(join(tsOnly, 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(tsOnly, 'index.ts'), 'export {};\n');
  assert.equal(resolveBarrelPath(tsOnly), join(tsOnly, 'index.ts'), 'index.ts is preferred over index.js');
});

test('a system whose only barrel is index.js (MUI shape: index.js + index.d.ts, no index.ts) still extracts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-js-barrel-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'Widget'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/js-barrel' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  // No src/index.ts at all — only a compiled-JS barrel plus its type
  // declarations, exactly MUI's packages/mui-material/src shape.
  writeFileSync(join(src, 'index.js'), "export * from './Widget';\n");
  writeFileSync(join(src, 'index.d.ts'), "export * from './Widget';\n");
  writeFileSync(join(src, 'Widget', 'index.ts'), "export { Widget } from './Widget';\n");
  writeFileSync(join(src, 'Widget', 'Widget.tsx'), 'export const Widget = () => <div />;\n');

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  assert.ok(catalog.allExports.includes('Widget'), 'Widget discovered via the .js barrel');
  const widgetDir = catalog.components.find((c) => c.dir === 'Widget');
  assert.ok(widgetDir, 'Widget landed as a full catalog component, not just an allExports stub');
  assert.ok(widgetDir!.exports.some((e) => e.displayName === 'Widget'));
});

test('docgen extraction throws an actionable error when no barrel entry point exists at all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-no-barrel-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true }); // no index.* of any kind
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/no-barrel' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx' } }));

  await assert.rejects(
    () => extractDocgenCatalog('synthetic', makeConfig(root)),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /no barrel entry point/);
      assert.ok(err.message.includes(src));
      return true;
    },
  );
});

test('export * into a dir holding only an index.js resolves (the four skipped MUI targets)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-js-dir-index-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'Zoom'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/js-dir-index' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', allowJs: true } }));

  writeFileSync(join(src, 'index.ts'), "export * from './Zoom';\n");
  // The target dir has ONLY a JS barrel (MUI's src layout).
  writeFileSync(join(src, 'Zoom', 'index.js'), "export { Zoom } from './Zoom.js';\n");
  writeFileSync(join(src, 'Zoom', 'Zoom.js'), 'export const Zoom = () => null;\n');

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  assert.ok(catalog.allExports.includes('Zoom'), `Zoom missing from allExports: ${JSON.stringify(catalog.allExports)}`);
  assert.ok(catalog.components.some((c) => c.exports.some((e) => e.displayName === 'Zoom')), 'Zoom missing from components[]');
});

test('a parent-side default alias survives next to a resolvable export * (the MUI pairing)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-extract-alias-pair-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'Accordion'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@test/alias-pair' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', allowJs: true } }));

  // Root pairs a default alias with an export * of the same dir; the dir's
  // own module exports only `default` and a camelCase helper, so the public
  // PascalCase name exists ONLY in the parent's alias.
  writeFileSync(join(src, 'index.ts'), "export { default as Accordion } from './Accordion';\nexport * from './Accordion';\n");
  writeFileSync(join(src, 'Accordion', 'index.tsx'), "export { default } from './Accordion.js';\nexport const accordionClasses = { root: 'x' };\n");
  writeFileSync(join(src, 'Accordion', 'Accordion.tsx'), 'const Accordion = () => <div />;\nexport default Accordion;\n');

  const catalog = await extractDocgenCatalog('synthetic', makeConfig(root));
  const names = catalog.components.flatMap((c) => c.exports.map((e) => e.displayName));
  assert.ok(names.includes('Accordion'), `parent-side alias lost: ${JSON.stringify(names)}`);
});
