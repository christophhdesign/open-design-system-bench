// Offline verification of the "stencil" catalog strategy against a synthetic
// Stencil library in a temp dir — the shape that broke the docgen extractor:
// a root barrel re-exporting the compiler's virtual `./components` module,
// component dirs nested under grouping dirs, and `@Prop()` classes instead of
// React components. No network, no real design-system repos, no Stencil build.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import type { SystemConfig } from '../types.ts';
import { extractStencilCatalog, tagToClassName, tagsOnDisk } from './catalog-stencil.ts';
import { NO_FOUNDATIONS_CSS_HASH, extractSystemTokens } from './tokens.ts';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/**
 * A Stencil package with two components in different grouping dirs, one of
 * them deprecated, plus a root barrel whose only interesting statement is the
 * unresolvable `export * from './components'` the compiler synthesizes.
 */
function writeSyntheticStencilSystem(opts?: { extraTagOnDisk?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'odsys-stencil-'));
  const pkg = join(root, 'packages/components');
  const src = join(pkg, 'src');

  write(
    join(src, 'index.ts'),
    ["export { setAssetPath } from '@stencil/core';", "export * from './components';"].join('\n'),
  );

  write(
    join(src, 'components/controls/ds-button/ds-button.tsx'),
    [
      "import { Component, Prop, h } from '@stencil/core';",
      '@Component({',
      "  tag: 'ds-button',",
      '  shadow: true,',
      '})',
      'export class DsButton {',
      '  @Prop() controlType: string;',
      '}',
    ].join('\n'),
  );

  write(
    join(src, 'components/messaging/ds-alert/ds-alert.tsx'),
    [
      "import { Component, h } from '@stencil/core';",
      "@Component({ tag: 'ds-alert' })",
      'export class DsAlert {}',
    ].join('\n'),
  );

  // A component the docs.json doesn't know about — used by the staleness test.
  if (opts?.extraTagOnDisk) {
    write(
      join(src, `components/controls/${opts.extraTagOnDisk}/${opts.extraTagOnDisk}.tsx`),
      [`@Component({ tag: '${opts.extraTagOnDisk}' })`, 'export class Extra {}'].join('\n'),
    );
  }

  // A .tsx that is not a component must not register as a tag.
  write(join(src, 'components/controls/ds-button/ds-button.stories.tsx'), "export const tag = 'ds-not-a-component';\n");

  write(
    join(src, 'docs.json'),
    JSON.stringify({
      timestamp: '2026-09-03',
      components: [
        {
          tag: 'ds-button',
          filePath: 'src/components/controls/ds-button/ds-button.tsx',
          docs: 'A button.',
          docsTags: [],
          props: [
            {
              name: 'controlType',
              attr: 'control-type',
              type: '"icon" | "text"',
              docs: 'Show an icon or text.',
              default: "'icon'",
              required: false,
              docsTags: [],
            },
            // An object prop has no attribute form: Stencil omits `attr`.
            { name: 'config', type: 'ButtonConfig', docs: '', required: true, docsTags: [] },
          ],
          events: [{ event: 'pressed', detail: 'void', docs: 'Emitted on press.', docsTags: [] }],
        },
        {
          tag: 'ds-alert',
          filePath: 'src/components/messaging/ds-alert/ds-alert.tsx',
          docs: 'An alert.',
          docsTags: [{ name: 'deprecated', text: 'Use ds-banner instead.' }],
          deprecation: 'Use ds-banner instead.',
          props: [],
          events: [],
        },
      ],
    }),
  );

  return root;
}

function cfgFor(root: string): SystemConfig {
  return {
    root,
    rootEnv: 'ODSYS_TEST_STENCIL_DIR',
    componentsSrc: 'packages/components/src',
    componentsPkg: '@test/stencil',
    foundationsPkg: '@test/stencil-tokens',
    catalogStrategy: 'stencil',
    catalogFile: 'packages/components/src/docs.json',
    agentContext: { agentsMd: [] },
  };
}

test('tagToClassName follows Stencil own tag-to-class rule', () => {
  assert.equal(tagToClassName('ds-button'), 'DsButton');
  assert.equal(tagToClassName('ds-app-store-button'), 'DsAppStoreButton');
  assert.equal(tagToClassName('my-el'), 'MyEl');
});

test('stencil strategy extracts a catalog from docs.json where docgen finds nothing', async () => {
  const root = writeSyntheticStencilSystem();
  try {
    const catalog = await extractStencilCatalog('stencil-test', cfgFor(root));

    assert.equal(catalog.components.length, 2);

    // filePath is relative to the Stencil project root (packages/components)
    // while componentsSrc is relative to the system root — the overlapping
    // leading segments are resolved against disk, not guessed.
    assert.deepEqual(
      catalog.components.map((c) => c.dir).sort(),
      ['components/controls/ds-button', 'components/messaging/ds-alert'],
    );

    // The tag is the documented export; the PascalCase class name is a second
    // gradeable spelling, not a second component (it would otherwise double
    // every export count and read as undocumented in docs-greppability).
    const button = catalog.components.find((c) => c.dir.endsWith('ds-button'));
    assert.ok(button);
    assert.deepEqual(button.exports.map((e) => e.displayName), ['ds-button']);
    assert.deepEqual(button.exports[0].props.map((p) => p.name), ['controlType', 'config']);
    assert.ok(catalog.allExports.includes('DsButton'), 'the class name is still gradeable');
    assert.deepEqual(catalog.allPropsByExport['ds-button'], catalog.allPropsByExport.DsButton);
    assert.equal(
      catalog.components.reduce((n, c) => n + c.exports.length, 0),
      2,
      'one documented export per component, not one per spelling',
    );

    // Prop metadata survives the normalization.
    const controlType = button.exports[0].props[0];
    assert.equal(controlType.type, '"icon" | "text"');
    assert.equal(controlType.defaultValue, "'icon'");
    assert.equal(controlType.required, false);
    assert.equal(controlType.description, 'Show an icon or text.');
    assert.equal(button.exports[0].props[1].required, true);

    // The barrel walk still contributes what it can statically reach, even
    // though the virtual './components' module resolves to nothing.
    assert.ok(catalog.allExports.includes('setAssetPath'));
    assert.ok(catalog.allExports.includes('ds-alert'));
    assert.ok(catalog.allExports.includes('DsAlert'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stencil strategy grades attribute and event-handler spellings without diluting documented props', async () => {
  const root = writeSyntheticStencilSystem();
  try {
    const catalog = await extractStencilCatalog('stencil-test', cfgFor(root));
    const props = catalog.allPropsByExport['ds-button'];

    // Kebab attribute alias and the output-target event handler are gradeable...
    assert.ok(props.includes('control-type'), 'kebab attribute alias is accepted');
    assert.ok(props.includes('onPressed'), 'event handler prop is accepted');
    // ...but a prop with no attribute form contributes no alias.
    assert.ok(!props.some((p) => p === 'config-'), 'no alias invented for an attribute-less prop');

    // ...and neither shows up as a documented prop, so catalog-quality's
    // per-prop coverage still measures the real documented surface.
    const button = catalog.components.find((c) => c.dir.endsWith('ds-button'));
    assert.deepEqual(button?.exports[0].props.map((p) => p.name), ['controlType', 'config']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stencil strategy carries deprecation into the description where the audit can grep it', async () => {
  const root = writeSyntheticStencilSystem();
  try {
    const catalog = await extractStencilCatalog('stencil-test', cfgFor(root));
    const alert = catalog.components.find((c) => c.dir.endsWith('ds-alert'));
    assert.ok(alert);
    assert.match(alert.exports[0].description, /^@deprecated Use ds-banner instead\./);
    assert.match(alert.exports[0].description, /An alert\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tagsOnDisk finds nested @Component tags and ignores non-component tsx', () => {
  const root = writeSyntheticStencilSystem();
  try {
    assert.deepEqual(tagsOnDisk(join(root, 'packages/components/src')), ['ds-alert', 'ds-button']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stencil strategy refuses a docs.json that is stale vs the components on disk', async () => {
  const root = writeSyntheticStencilSystem({ extraTagOnDisk: 'ds-brand-new' });
  try {
    await assert.rejects(
      () => extractStencilCatalog('stencil-test', cfgFor(root)),
      /is stale.*ds-brand-new/s,
    );
    // --allow-stale downgrades it to a warning and still returns a catalog.
    const catalog = await extractStencilCatalog('stencil-test', cfgFor(root), { allowStale: true });
    assert.equal(catalog.components.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stencil strategy fails with an actionable message when catalogFile is missing or wrong-shaped', async () => {
  const root = writeSyntheticStencilSystem();
  try {
    await assert.rejects(
      () => extractStencilCatalog('stencil-test', { ...cfgFor(root), catalogFile: undefined }),
      /missing catalogFile/,
    );
    await assert.rejects(
      () => extractStencilCatalog('stencil-test', { ...cfgFor(root), catalogFile: 'packages/components/src/nope.json' }),
      /could not read stencil docs\.json/,
    );

    writeFileSync(join(root, 'packages/components/src/wrong.json'), JSON.stringify({ version: 1, components: undefined }));
    await assert.rejects(
      () => extractStencilCatalog('stencil-test', { ...cfgFor(root), catalogFile: 'packages/components/src/wrong.json' }),
      /does not look like Stencil docs-json output/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multi-file foundationsCss
// ---------------------------------------------------------------------------
//
// A per-category token set with no aggregate CSS entry point is what pushed
// foundationsCss from `string` to `string | string[]` (Admiral ships nineteen
// files and only a .scss that `@use`s them). One file and several must behave
// identically apart from the union.

test('foundationsCss accepts several files and reads them as one document', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-tokens-multi-'));
  try {
    write(join(root, 'css/palette.css'), ':root {\n  --palette-blue: #00f;\n  --palette-red: #f00;\n}\n');
    // No trailing newline: the join must not glue this onto the next file.
    writeFileSync(join(root, 'css/spacing.css'), ':root {\n  --spacing-sm: 4px;\n}', 'utf8');
    write(join(root, 'css/theme.css'), ':root {\n  --text-primary: var(--palette-blue);\n}\n@utility heading-lg {}\n');

    const base = { ...cfgFor(root), foundationsCss: undefined } as SystemConfig;

    const one = await extractSystemTokens('t', { ...base, foundationsCss: 'css/palette.css' });
    assert.deepEqual(one.cssVars, ['--palette-blue', '--palette-red']);

    const many = await extractSystemTokens('t', {
      ...base,
      foundationsCss: ['css/palette.css', 'css/spacing.css', 'css/theme.css'],
    });
    assert.deepEqual(many.cssVars, ['--palette-blue', '--palette-red', '--spacing-sm', '--text-primary']);
    assert.deepEqual(many.utilities, ['heading-lg']);
    assert.deepEqual(many.typographyUtilities, ['heading-lg']);
    assert.notEqual(many.cssHash, one.cssHash, 'the hash covers every listed file');

    // A partially readable list is honest about what it saw rather than failing.
    const partial = await extractSystemTokens('t', {
      ...base,
      foundationsCss: ['css/palette.css', 'css/gone.css'],
    });
    assert.deepEqual(partial.cssVars, ['--palette-blue', '--palette-red']);

    // But a list where nothing is readable is a typo'd path, not a system
    // without tokens — that must fail loudly.
    await assert.rejects(
      () => extractSystemTokens('t', { ...base, foundationsCss: ['css/gone.css'] }),
      /could not be read/,
    );

    // Omitted entirely stays the documented no-op.
    const none = await extractSystemTokens('t', base);
    assert.deepEqual(none.cssVars, []);
    assert.equal(none.cssHash, NO_FOUNDATIONS_CSS_HASH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
