// Orchestrates the seven Tier-0 static-audit checks for one system. No
// network, no `claude` calls, by default — every check is local file reads +
// parsing, which is what keeps `open-design-system-bench audit` at "scores a
// repo in <60s with no API key at all" (see ROADMAP.md's P1 exit criterion).
//
// P3 adds exactly one opt-in exception: when a system configures `docsUrl`,
// this module fetches its hosted-surface probes (see hosted.ts) ONCE per
// system, before any check runs, and threads the result to every check via
// AuditDirs.hosted. No docsUrl configured -> the network is never touched,
// so the offline guarantee above holds byte-for-byte for every system that
// doesn't opt in.

import type { SystemConfig, SystemId } from '../types.ts';
import type { AuditCheckFn, AuditCheckResult, AuditDirs } from './types.ts';
import { checkSurface } from './checks/surface.ts';
import { checkCatalogQuality } from './checks/catalog-quality.ts';
import { checkExportHygiene } from './checks/export-hygiene.ts';
import { checkVocabulary } from './checks/vocabulary.ts';
import { checkTokens } from './checks/tokens.ts';
import { checkDeprecation } from './checks/deprecation.ts';
import { checkDocsGreppability } from './checks/docs-greppability.ts';
import { probeHostedSurface } from './hosted.ts';

interface CheckSpec {
  id: string;
  title: string;
  fn: AuditCheckFn;
}

/** Order matches the Tier-0 catalog numbering in ROADMAP.md. id/title here are the fallback used if the check itself throws before returning its own. */
export const AUDIT_CHECKS: CheckSpec[] = [
  { id: 'surface', title: 'Enablement surface', fn: checkSurface },
  { id: 'catalog-quality', title: 'Catalog quality', fn: checkCatalogQuality },
  { id: 'export-hygiene', title: 'Export hygiene', fn: checkExportHygiene },
  { id: 'vocabulary', title: 'Vocabulary convention-distance', fn: checkVocabulary },
  { id: 'tokens', title: 'Token machine-readability', fn: checkTokens },
  { id: 'deprecation', title: 'Deprecation legibility', fn: checkDeprecation },
  { id: 'docs-greppability', title: 'Docs greppability', fn: checkDocsGreppability },
];

/**
 * Resolves AuditDirs.hosted exactly once per system — see the three-state
 * contract documented on that field in types.ts. `offline` is the CLI's
 * `--offline` flag; it exists specifically so an operator with docsUrl
 * configured can still get a fully offline run without editing
 * systems.config.json. Exported so cli.ts can resolve it once and both feed
 * it to runAuditChecks (which reuses it rather than re-probing — see below)
 * and attach it to the `audit --json` report.
 */
export async function resolveHostedSurface(cfg: SystemConfig, offline: boolean): Promise<AuditDirs['hosted']> {
  if (!cfg.docsUrl) return undefined;
  if (offline) return 'offline';
  return probeHostedSurface(cfg.docsUrl);
}

/**
 * Runs every Tier-0 check for one system. Each check is individually
 * try/caught: a check must degrade gracefully on its own (missing catalog,
 * missing tokens, …), but this is the last line of defense — a bug in one
 * check must never take down the other six or the whole `audit` command.
 *
 * `offline` (default false) skips hosted-surface probing even when the
 * system configures `docsUrl` — see cmdAudit's `--offline` flag in cli.ts.
 * `dirs.hosted`, if already resolved by the caller (cli.ts does this so it
 * can also attach the result to the `audit --json` report), is reused as-is
 * instead of being probed again; otherwise it's resolved here.
 */
export async function runAuditChecks(system: SystemId, cfg: SystemConfig, dirs: AuditDirs, offline = false): Promise<AuditCheckResult[]> {
  const hosted = dirs.hosted !== undefined ? dirs.hosted : await resolveHostedSurface(cfg, offline);
  const dirsWithHosted: AuditDirs = { ...dirs, hosted };

  const results: AuditCheckResult[] = [];
  for (const spec of AUDIT_CHECKS) {
    try {
      results.push(await spec.fn(system, cfg, dirsWithHosted));
    } catch (err) {
      results.push({
        id: spec.id,
        title: spec.title,
        score: null,
        findings: [{ severity: 'fail', message: `Check crashed: ${err instanceof Error ? err.message : String(err)}` }],
      });
    }
  }
  return results;
}
