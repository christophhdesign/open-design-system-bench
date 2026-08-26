// Tier-0 check 2: Catalog quality. Given a machine-readable catalog (loaded
// via loadCatalogForAudit — see that module for the three-tier fallback),
// scores how *complete* it is as documentation an agent can act on: does
// every export have a props table, and does every prop carry a type, a
// default, and a description. When no catalog is available at all for a
// docgen-strategy system, scores docgen preconditions instead (partial
// credit — we know extraction *could* work, just haven't proven it did).

import type { SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { loadCatalogForAudit } from '../catalog-loader.ts';
import { round1, clamp } from '../util.ts';

function pct(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

export async function checkCatalogQuality(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult> {
  const findings: AuditFinding[] = [];
  const load = await loadCatalogForAudit(system, cfg, dirs.catalogsDir);

  if (!load.catalog) {
    if (load.source === 'none-docgen' && load.docgenPreconditions) {
      const { tsconfigExists, tsxComponentCount } = load.docgenPreconditions;
      const ok = tsconfigExists && tsxComponentCount > 0;
      findings.push({
        severity: ok ? 'warn' : 'fail',
        message: ok
          ? `No extracted catalog, but docgen preconditions are met (tsconfig.json present, ${tsxComponentCount} candidate .tsx files): quality is unverified until "npm run extract" runs.`
          : `No extracted catalog and docgen preconditions are not met (tsconfig.json ${tsconfigExists ? 'present' : 'MISSING'}, ${tsxComponentCount} candidate .tsx files).`,
        fix: 'Run "npm run extract" to produce a scoreable catalog.',
      });
      // Partial credit only: we've confirmed extraction *could* run, not
      // what it would find. 40 reflects "plausible", never "good".
      return { id: 'catalog-quality', title: 'Catalog quality', score: ok ? 40 : 10, findings };
    }
    findings.push({
      severity: 'fail',
      message: `No machine-readable catalog available for "${system}" (strategy: ${cfg.catalogStrategy}).`,
      fix: cfg.catalogFile
        ? `Expected ${cfg.catalogFile} to exist and be readable JSON.`
        : 'Configure catalogFile, or run "npm run extract" for docgen strategies.',
    });
    return { id: 'catalog-quality', title: 'Catalog quality', score: null, findings };
  }

  const { catalog } = load;
  let totalExports = 0;
  let exportsWithProps = 0;
  let totalProps = 0;
  let propsWithType = 0;
  let propsWithDefault = 0;
  let propsWithDescription = 0;

  for (const comp of catalog.components) {
    for (const exp of comp.exports) {
      totalExports += 1;
      if (exp.props.length > 0) exportsWithProps += 1;
      for (const p of exp.props) {
        totalProps += 1;
        if (p.type && p.type.trim() !== '' && p.type.trim().toLowerCase() !== 'unknown') propsWithType += 1;
        if (p.defaultValue != null && String(p.defaultValue).trim() !== '') propsWithDefault += 1;
        if (p.description && p.description.trim() !== '') propsWithDescription += 1;
      }
    }
  }

  const pctExportsWithProps = pct(exportsWithProps, totalExports);
  const pctType = pct(propsWithType, totalProps);
  const pctDefault = pct(propsWithDefault, totalProps);
  const pctDescription = pct(propsWithDescription, totalProps);

  findings.push({
    severity: 'info',
    message: `${catalog.components.length} component dirs, ${totalExports} exports, ${totalProps} props documented.`,
  });
  if (pctExportsWithProps < 70) {
    findings.push({ severity: 'warn', message: `Only ${round1(pctExportsWithProps)}% of exports have a documented props table.` });
  }
  if (pctType < 80) {
    findings.push({ severity: 'warn', message: `Only ${round1(pctType)}% of props have a resolved type.`, fix: 'Untyped props force an agent to guess valid values instead of reading them.' });
  }
  if (pctDescription < 50) {
    findings.push({ severity: 'warn', message: `Only ${round1(pctDescription)}% of props have a description.`, fix: 'JSDoc on prop declarations flows straight into the catalog via docgen.' });
  }

  // Weights: type coverage matters most (an agent can infer a lot from a
  // resolved type, almost nothing from an opaque one) — 35. Description and
  // "has any props at all" are next — 25 each. defaultValue is weighted
  // lowest (15): many required/no-default props are legitimately correct,
  // so 100% default coverage isn't actually the target the way 100% type
  // coverage is.
  const score =
    totalExports === 0 ? 0 : pctExportsWithProps * 0.25 + pctType * 0.35 + pctDescription * 0.25 + pctDefault * 0.15;

  return { id: 'catalog-quality', title: 'Catalog quality', score: round1(clamp(score, 0, 100)), findings };
}
