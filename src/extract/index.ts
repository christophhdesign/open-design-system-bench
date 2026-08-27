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

const CATALOG_SIZE_WARN_BYTES = 10 * 1024 * 1024; // 10 MB

function writeJson(path: string, data: unknown, opts?: { warnIfLarge?: boolean }): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(path, json, 'utf8');
  const byteSize = Buffer.byteLength(json, 'utf8');
  if (opts?.warnIfLarge && byteSize > CATALOG_SIZE_WARN_BYTES) {
    const mb = byteSize / (1024 * 1024);
    console.warn(
      `[extract] ${path} is ${mb.toFixed(1)} MB. Likely cause: inherited-prop metadata or docgen over-expansion (a component intersecting a large third-party prop type). This is a guard, not a failure — extraction still succeeded.`,
    );
  }
}

// "documented exports" counts only the exports react-docgen(-typescript) (or
// the catalog-json strategy's own prebuilt data) turned into a component
// entry with a props table — i.e. every components[].exports[] item.
// "barrel exports(all)" counts every name the public barrel makes reachable
// at all, values and types alike (allExports) — hooks, variant-class
// helpers, re-exported prop types, and so on. The two numbers diverge a lot
// on a real system (665 vs 273 on Carbon) and operators reading a bare
// `exports=N` line reasonably assumed it meant "components", not "every
// barrel-reachable name" — so both are labeled and printed side by side
// instead of one line silently meaning two different things.
function summarize(system: SystemId, catalog: SystemCatalog, tokens: SystemTokens): string {
  const documentedExports = catalog.components.reduce((n, c) => n + c.exports.length, 0);
  return (
    `[extract:${system}] component dirs=${catalog.components.length}, ` +
    `documented exports=${documentedExports}, ` +
    `barrel exports(all)=${catalog.allExports.length}, ` +
    `props=${Object.values(catalog.allPropsByExport).reduce((n, p) => n + p.length, 0)}, ` +
    `cssVars=${tokens.cssVars.length}, ` +
    `utilities=${tokens.utilities.length}`
  );
}

export async function runExtract(opts: {
  systems?: SystemId[];
  allowStale?: boolean;
  configPath?: string;
  catalogsDir?: string;
  tokensDir?: string;
}): Promise<number> {
  const systemsConfig = loadSystems(opts.configPath);
  const systems = opts.systems ?? (Object.keys(systemsConfig) as SystemId[]);
  const catalogsDir = opts.catalogsDir ?? paths.catalogsDir;
  const tokensDir = opts.tokensDir ?? paths.tokensDir;

  // A multi-system `extract` must not let one system's failure take down
  // every system after it in the list (a real Primer extraction threw and
  // killed the whole process before Base UI or Radix, later in the same
  // list, ever ran). Each system's work is isolated in its own try/catch;
  // failures are logged (message only — a stack trace is noise for an
  // operator scanning a multi-system run) and the loop continues. Only after
  // every system has had a chance to run does a failure become fatal to the
  // process, via a nonzero exit code and a one-line roll-up. A single-system
  // invocation still ends up failing the process (same as before), just with
  // a cleaner message instead of an uncaught-exception stack trace.
  const failed: SystemId[] = [];

  for (const system of systems) {
    try {
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

      writeJson(catalogPath(system, catalogsDir), catalog, { warnIfLarge: true });
      writeJson(tokensPath(system, tokensDir), tokens);

      console.log(summarize(system, catalog, tokens));
    } catch (err) {
      failed.push(system);
      console.error(`[extract:${system}] FAILED: ${(err as Error).message}`);
    }
  }

  if (failed.length > 0) {
    console.error(`extract: ${failed.length} of ${systems.length} systems failed: ${failed.join(', ')}`);
  }
  return failed.length;
}
