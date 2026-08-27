// Catalog-quality check tests scoped to the own/inherited props split (Phase
// 2 item 2.3): own-only coverage math, and the inherited-prop-count
// reporting in the info finding. A separate file from audit.test.ts (which
// another agent owns concurrently) rather than adding to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SystemCatalog, SystemConfig } from '../types.ts';
import { catalogPath } from '../config.ts';
import { checkCatalogQuality } from './checks/catalog-quality.ts';
import type { AuditDirs } from './types.ts';

function writeSyntheticCatalog(catalog: SystemCatalog): { cfg: SystemConfig; dirs: AuditDirs } {
  const root = mkdtempSync(join(tmpdir(), 'odsys-audit-catalog-quality-'));
  const catalogsDir = join(root, '.audit-data', 'catalogs');
  const tokensDir = join(root, '.audit-data', 'tokens');
  mkdirSync(catalogsDir, { recursive: true });
  writeFileSync(catalogPath(catalog.system, catalogsDir), JSON.stringify(catalog, null, 2));

  const cfg: SystemConfig = {
    root,
    rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_CATALOG_QUALITY_TEST_DIR',
    componentsSrc: 'src',
    componentsPkg: '@testkit/components',
    foundationsPkg: '@testkit/foundations',
    catalogStrategy: 'catalog-json',
    catalogFile: 'src/catalog.json', // deliberately absent on disk — the pre-extracted snapshot above wins
    agentContext: { agentsMd: [] },
  };
  return { cfg, dirs: { catalogsDir, tokensDir } };
}

test('coverage is computed over own props only; the info finding reports the inherited-prop-name count', async () => {
  const catalog: SystemCatalog = {
    system: 'testkit',
    generatedAt: new Date().toISOString(),
    source: { root: '/tmp/testkit', commit: 'test', srcHash: 'test' },
    components: [
      {
        dir: 'box',
        exports: [
          {
            displayName: 'Box',
            description: 'A layout primitive.',
            // Full coverage on every own prop: if the (much larger) inherited
            // count below leaked into the coverage math, these percentages
            // would drop well below 100.
            props: [
              { name: 'as', type: 'string', required: false, defaultValue: 'div', description: 'The rendered element.' },
              { name: 'children', type: 'ReactNode', required: false, defaultValue: 'null', description: 'Box contents.' },
            ],
            inheritedProps: ['bg', 'm', 'p'],
          },
        ],
      },
    ],
    allExports: ['Box'],
    allPropsByExport: { Box: ['as', 'children', 'bg', 'm', 'p'] },
  };
  const { cfg, dirs } = writeSyntheticCatalog(catalog);

  const result = await checkCatalogQuality('testkit', cfg, dirs);

  assert.equal(result.score, 100, 'own-prop coverage is complete; the inherited names must not dilute it');

  const info = result.findings.find((f) => f.severity === 'info');
  assert.ok(info, 'an info finding is present');
  assert.match(info!.message, /1 component dirs, 1 exports, 2 props documented/);
  assert.match(info!.message, /3 inherited prop names recorded \(not counted toward coverage\)/);
});

test('an export with no inherited props leaves the info finding unchanged (no inherited-count mention)', async () => {
  const catalog: SystemCatalog = {
    system: 'testkit',
    generatedAt: new Date().toISOString(),
    source: { root: '/tmp/testkit', commit: 'test', srcHash: 'test' },
    components: [
      {
        dir: 'toggle',
        exports: [
          {
            displayName: 'Toggle',
            description: 'An on/off control.',
            props: [{ name: 'checked', type: 'boolean', required: false, defaultValue: 'false', description: 'Whether the toggle is on.' }],
          },
        ],
      },
    ],
    allExports: ['Toggle'],
    allPropsByExport: { Toggle: ['checked'] },
  };
  const { cfg, dirs } = writeSyntheticCatalog(catalog);

  const result = await checkCatalogQuality('testkit', cfg, dirs);

  const info = result.findings.find((f) => f.severity === 'info');
  assert.ok(info, 'an info finding is present');
  assert.match(info!.message, /1 component dirs, 1 exports, 1 props documented\.$/);
  assert.ok(!info!.message.includes('inherited prop names'), 'no inheritedProps anywhere means no inherited-count mention');
});

test('an empty extracted catalog is unmeasured (score null, loud warning), never scored as a bad catalog', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-cq-empty-'));
  const catalogsDir = join(root, 'catalogs');
  try {
    mkdirSync(catalogsDir, { recursive: true });
    // The Radix field-test shape: extract exits 0 but walks nothing.
    writeFileSync(
      join(catalogsDir, 'emptykit.json'),
      JSON.stringify({ system: 'emptykit', generatedAt: 'x', source: { root, commit: 'none', srcHash: 'x' }, components: [], allExports: [], allPropsByExport: {} }),
    );
    const cfg: SystemConfig = {
      root,
      rootEnv: 'OPEN_DESIGN_SYSTEM_BENCH_EMPTYKIT_DIR',
      componentsSrc: 'src',
      componentsPkg: '@emptykit/components',
      foundationsPkg: '@emptykit/foundations',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    const result = await checkCatalogQuality('emptykit', cfg, { catalogsDir, tokensDir: join(root, 't') });
    assert.equal(result.score, null, 'empty extract must be unmeasured, not scored');
    assert.ok(result.findings.some((f) => f.message.includes('EMPTY catalog')), 'expected the loud empty-extract warning');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
