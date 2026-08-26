// Orchestrates the seven Tier-0 static-audit checks for one system. No
// network, no `claude` calls — every check is local file reads + parsing,
// which is what keeps `open-design-system-bench audit` at "scores a repo in <60s with
// no API key at all" (see ROADMAP.md's P1 exit criterion).

import type { SystemConfig, SystemId } from '../types.ts';
import type { AuditCheckFn, AuditCheckResult, AuditDirs } from './types.ts';
import { checkSurface } from './checks/surface.ts';
import { checkCatalogQuality } from './checks/catalog-quality.ts';
import { checkExportHygiene } from './checks/export-hygiene.ts';
import { checkVocabulary } from './checks/vocabulary.ts';
import { checkTokens } from './checks/tokens.ts';
import { checkDeprecation } from './checks/deprecation.ts';
import { checkDocsGreppability } from './checks/docs-greppability.ts';

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
 * Runs every Tier-0 check for one system. Each check is individually
 * try/caught: a check must degrade gracefully on its own (missing catalog,
 * missing tokens, …), but this is the last line of defense — a bug in one
 * check must never take down the other six or the whole `audit` command.
 */
export async function runAuditChecks(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult[]> {
  const results: AuditCheckResult[] = [];
  for (const spec of AUDIT_CHECKS) {
    try {
      results.push(await spec.fn(system, cfg, dirs));
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
