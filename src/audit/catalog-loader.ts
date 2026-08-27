// Best-effort catalog loading for the audit checks that need one
// (catalog-quality, vocabulary, docs-greppability). Three tiers, in order:
//
//  1. A pre-extracted snapshot at catalogPath(system, catalogsDir) — either
//     the package's own top-level catalogs/ output from a prior `npm run
//     extract`, or a committed examples/*/data/catalogs/*.json snapshot
//     (resolveDataDirs handles which). This is the common case and needs no
//     parsing beyond JSON.parse.
//  2. catalog-json strategy with no snapshot: read the system's own
//     configured catalogFile directly via the same static, local parser
//     `extract` uses (extractCatalogJsonCatalog). allowStale:true because
//     that function's staleness guard is a write-time safety check for
//     `extract` — a read-only audit should report staleness as a finding,
//     never throw.
//  3. docgen strategy with no snapshot: we deliberately do NOT invoke
//     react-docgen-typescript here (that's `extract`'s job, and running full
//     docgen for every configured system on every `audit` invocation would
//     undercut "scores a repo in <60s"). Instead we report whether docgen
//     preconditions look satisfiable (tsconfig.json present, .tsx component
//     files present) so catalog-quality can award partial credit and explain
//     exactly what `npm run extract` would need.
//
// Every branch is wrapped so a malformed/missing file degrades to "no
// catalog" rather than throwing — audit checks must never crash a run.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogPath } from '../config.ts';
import type { SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import { extractCatalogJsonCatalog } from '../extract/catalog-json.ts';
import { findTsconfigUpward } from '../extract/normalize.ts';
import { walkFiles } from './fs-walk.ts';

export type CatalogSource = 'pre-extracted' | 'catalog-json-live' | 'none-catalog-json' | 'none-docgen';

export interface DocgenPreconditions {
  tsconfigExists: boolean;
  tsxComponentCount: number;
}

export interface CatalogLoadResult {
  catalog: SystemCatalog | null;
  source: CatalogSource;
  /** Only set when source === 'none-docgen'. */
  docgenPreconditions?: DocgenPreconditions;
}

function countTsxComponentFiles(srcDir: string): number {
  return walkFiles(srcDir, { extensions: ['.tsx'] }).filter(
    (f) => !f.relPath.includes('.spec.') && !f.relPath.includes('.stories.') && !f.relPath.includes('.figma.'),
  ).length;
}

export async function loadCatalogForAudit(
  system: SystemId,
  cfg: SystemConfig,
  catalogsDir: string,
): Promise<CatalogLoadResult> {
  const preExtracted = catalogPath(system, catalogsDir);
  if (existsSync(preExtracted)) {
    try {
      const catalog = JSON.parse(readFileSync(preExtracted, 'utf8')) as SystemCatalog;
      return { catalog, source: 'pre-extracted' };
    } catch {
      // fall through — treat as if no snapshot existed
    }
  }

  if (cfg.catalogStrategy === 'catalog-json') {
    if (cfg.catalogFile && existsSync(join(cfg.root, cfg.catalogFile))) {
      try {
        const catalog = await extractCatalogJsonCatalog(system, cfg, { allowStale: true });
        return { catalog, source: 'catalog-json-live' };
      } catch {
        return { catalog: null, source: 'none-catalog-json' };
      }
    }
    return { catalog: null, source: 'none-catalog-json' };
  }

  // docgen strategy, no snapshot available.
  const srcDir = join(cfg.root, cfg.componentsSrc);
  return {
    catalog: null,
    source: 'none-docgen',
    docgenPreconditions: {
      // Monorepos keep tsconfig.json at the package or repo root rather than
      // exactly one level above componentsSrc — search upward through root
      // so partial credit doesn't zero out on those layouts.
      tsconfigExists: findTsconfigUpward(srcDir, cfg.root) !== undefined,
      tsxComponentCount: countTsxComponentFiles(srcDir),
    },
  };
}
