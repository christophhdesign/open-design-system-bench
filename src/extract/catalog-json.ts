// "catalog-json" strategy: the system's own repo already ships a
// machine-readable component catalog (e.g. built via react-docgen-typescript
// by the system's own docs tooling). We just read + normalize it into our
// SystemCatalog shape, after checking it isn't stale relative to the live
// component dirs.

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CatalogExport, CatalogProp, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import { buildIndexes, collectBarrelExports, gitCommit, hashPaths, mergeBarrelExports } from './normalize.ts';

interface JsonCatalogProp {
  name: string;
  type: string | null;
  required: boolean;
  defaultValue: string | null;
  description: string;
}

interface JsonCatalogExport {
  displayName: string;
  description: string;
  props: JsonCatalogProp[];
}

interface JsonCatalogComponent {
  name: string;
  importPath: string;
  barrelImport: string;
  exports: JsonCatalogExport[];
  stories?: string[];
}

interface JsonCatalogFile {
  version: number;
  generatedAt: string;
  components: JsonCatalogComponent[];
}

/**
 * Compares the live component directories on disk against the names present
 * in the pre-built catalog file. If disk has directories the catalog doesn't
 * know about, the catalog is stale (someone added a component and hasn't
 * regenerated the catalog file yet). Throws unless `allowStale`, in which
 * case it warns and lets the (stale) catalog through.
 */
function checkStaleness(
  system: SystemId,
  cfg: SystemConfig,
  catalogComponentNames: string[],
  allowStale: boolean | undefined,
): void {
  const srcDir = join(cfg.root, cfg.componentsSrc);
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    // dir doesn't exist — nothing live to compare against
  }
  const liveDirs = entries
    .filter((e) => e.isDirectory() && e.name !== 'assets')
    .map((e) => e.name);

  // Case-insensitive compare: a stale checkout can end up with directory
  // casing that doesn't match the catalog's own naming convention.
  const catalogLower = new Set(catalogComponentNames.map((n) => n.toLowerCase()));
  const missing = liveDirs.filter((d) => !catalogLower.has(d.toLowerCase())).sort();

  if (missing.length === 0) return;

  const message =
    `${system} catalog-json file (${cfg.catalogFile}) is stale: found ${missing.length} ` +
    `component director${missing.length === 1 ? 'y' : 'ies'} under ${cfg.componentsSrc} ` +
    `not present in the catalog: ${missing.join(', ')}. ` +
    `Regenerate ${cfg.catalogFile} from ${cfg.root} using that system's own catalog-build tooling.`;

  if (allowStale) {
    console.warn(`[extract:${system}] ${message}`);
  } else {
    throw new Error(message);
  }
}

export async function extractCatalogJsonCatalog(
  system: SystemId,
  cfg: SystemConfig,
  opts?: { allowStale?: boolean },
): Promise<SystemCatalog> {
  if (!cfg.catalogFile) {
    throw new Error(`System config for "${system}" is missing catalogFile (required for the catalog-json strategy).`);
  }
  const catalogPath = join(cfg.root, cfg.catalogFile);
  const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as JsonCatalogFile;

  checkStaleness(
    system,
    cfg,
    raw.components.map((c) => c.name),
    opts?.allowStale,
  );

  const components: SystemCatalog['components'] = raw.components.map((vc) => ({
    dir: vc.name,
    exports: vc.exports.map((ve): CatalogExport => ({
      displayName: ve.displayName,
      description: ve.description ?? '',
      props: ve.props.map((vp): CatalogProp => ({
        name: vp.name,
        type: vp.type ?? 'unknown',
        required: !!vp.required,
        defaultValue: vp.defaultValue == null ? undefined : String(vp.defaultValue),
        description: vp.description ?? '',
      })),
    })),
  }));

  const { allExports, allPropsByExport } = buildIndexes(components);

  // The catalog file only covers components react-docgen-typescript (or
  // equivalent) turned into a props table. The public barrel
  // (packages/components/src/index.ts, one level up from componentsSrc)
  // re-exports more than that — foundational utilities, hooks, plus every
  // component barrel's own value + type exports. Merge the lot in with an
  // empty prop list where we don't already have real prop data.
  const barrelPath = join(cfg.root, dirname(cfg.componentsSrc), 'index.ts');
  mergeBarrelExports(collectBarrelExports(barrelPath), allExports, allPropsByExport);

  return {
    system,
    generatedAt: new Date().toISOString(),
    source: {
      root: cfg.root,
      commit: gitCommit(cfg.root),
      srcHash: hashPaths(cfg.root, [cfg.componentsSrc]),
    },
    components,
    allExports,
    allPropsByExport,
  };
}
