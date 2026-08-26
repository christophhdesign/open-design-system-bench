// Orchestrates ground-truth extraction for one or more systems: picks the
// right catalog strategy per systems.config.json (`docgen` or `catalog-json`),
// always extracts tokens, writes both to catalogs/<system>.json and
// tokens/<system>.json, and prints a one-line summary per system.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { catalogPath, loadSystems, paths, tokensPath } from '../config.ts';
import type { SystemCatalog, SystemId, SystemTokens } from '../types.ts';
import { extractCatalogJsonCatalog } from './catalog-json.ts';
import { extractDocgenCatalog } from './catalog-docgen.ts';
import { extractSystemTokens } from './tokens.ts';

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function summarize(system: SystemId, catalog: SystemCatalog, tokens: SystemTokens): string {
  return (
    `[extract:${system}] components=${catalog.components.length} ` +
    `exports=${catalog.allExports.length} ` +
    `props=${Object.values(catalog.allPropsByExport).reduce((n, p) => n + p.length, 0)} ` +
    `cssVars=${tokens.cssVars.length} ` +
    `utilities=${tokens.utilities.length}`
  );
}

export async function runExtract(opts: {
  systems?: SystemId[];
  allowStale?: boolean;
  configPath?: string;
  catalogsDir?: string;
  tokensDir?: string;
}): Promise<void> {
  const systemsConfig = loadSystems(opts.configPath);
  const systems = opts.systems ?? (Object.keys(systemsConfig) as SystemId[]);
  const catalogsDir = opts.catalogsDir ?? paths.catalogsDir;
  const tokensDir = opts.tokensDir ?? paths.tokensDir;

  for (const system of systems) {
    const cfg = systemsConfig[system];
    if (!cfg) throw new Error(`Unknown system "${system}" — not present in the systems config`);

    const catalog =
      cfg.catalogStrategy === 'catalog-json'
        ? await extractCatalogJsonCatalog(system, cfg, { allowStale: opts.allowStale })
        : await extractDocgenCatalog(system, cfg);

    if (!cfg.foundationsCss) {
      console.warn(`[extract:${system}] no foundationsCss configured — token-based checks will be limited`);
    }
    const tokens = await extractSystemTokens(system, cfg);

    writeJson(catalogPath(system, catalogsDir), catalog);
    writeJson(tokensPath(system, tokensDir), tokens);

    console.log(summarize(system, catalog, tokens));
  }
}
