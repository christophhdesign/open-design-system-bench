// Tier-0 check 2: Catalog quality. Given a machine-readable catalog (loaded
// via loadCatalogForAudit — see that module for the three-tier fallback),
// scores how *complete* it is as documentation an agent can act on: does
// every export have a props table, and does every prop carry a type, a
// default, and a description. When no catalog is available at all for a
// docgen-strategy system, scores docgen preconditions instead (partial
// credit — we know extraction *could* work, just haven't proven it did).
//
// Coverage is computed over each export's OWN props only (exp.props) —
// props whose declaration lives outside the system's componentsSrc tree
// (styled-system spreads, polymorphic factory types, DOM intersections) are
// recorded name-only in exp.inheritedProps and deliberately excluded from
// the coverage math: docgen never sees a type/description/default for those
// (they're not the system's documentation to begin with), so folding them
// in would just dilute a real coverage number with an unfixable one. The
// inherited count is still reported below, informationally.

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

  if (load.source === 'empty-extract') {
    // A snapshot with zero exports is the harness failing to walk the repo
    // layout, not a measured property of the system. Withholding the score
    // (instead of the docgen-preconditions partial credit, whose "tsconfig
    // present, N tsx files" would look deceptively healthy here) keeps an
    // unsupported layout from reading as a bad design system.
    findings.push({
      severity: 'warn',
      message: 'Extraction produced an EMPTY catalog (0 exports). This is almost certainly an unsupported repo layout (e.g. package-specifier re-exports across workspace packages), not evidence about the system. Score withheld.',
      fix: 'Point componentsSrc at a barrel the extractor can walk (relative re-exports), or re-run extract after fixing the layout mismatch.',
    });
    return { id: 'catalog-quality', title: 'Catalog quality', score: null, findings };
  }
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
  let totalInheritedProps = 0;
  let allInheritedExportCount = 0;
  const zeroPropExportNames: string[] = [];

  for (const comp of catalog.components) {
    for (const exp of comp.exports) {
      totalExports += 1;
      const inheritedCount = exp.inheritedProps?.length ?? 0;
      // "Has a props table" means extraction produced usable prop knowledge:
      // own metadata or at least inherited names. An export with ONLY
      // inherited props (a pure style-prop/factory component) is not an
      // extraction gap, so it neither counts as zero-prop nor feeds the
      // extraction-suspect ratio; it is tallied separately below.
      if (exp.props.length > 0 || inheritedCount > 0) {
        exportsWithProps += 1;
        if (exp.props.length === 0) allInheritedExportCount += 1;
      } else {
        zeroPropExportNames.push(exp.displayName);
      }
      totalInheritedProps += inheritedCount;
      // The prop-coverage counters below are scoped to non-zero-prop exports
      // by construction (an empty props array contributes nothing), which is
      // what makes them a real "of the props we did get" measure once
      // extraction-suspect kicks in.
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
  const pctZeroProp = pct(zeroPropExportNames.length, totalExports);
  // A docgen extraction that returns 0 props for a component is far more
  // likely to be an extraction gap (unresolved generics, a re-exported
  // third-party type, a forwardRef wrapper docgen couldn't see through) than
  // a genuinely prop-less component (field test: 63% of Mantine's exports
  // had 0 props, none of it flagged). 30% is a judgment-call threshold for
  // "enough zero-prop exports that this looks systematic, not incidental".
  const extractionSuspect = totalExports > 0 && pctZeroProp >= 30;

  findings.push({
    severity: 'info',
    message:
      `${catalog.components.length} component dirs, ${totalExports} exports, ${totalProps} props documented` +
      (totalInheritedProps > 0 ? `, ${totalInheritedProps} inherited prop names recorded (not counted toward coverage)` : '') +
      (allInheritedExportCount > 0 ? `, ${allInheritedExportCount} export(s) expose only inherited props.` : '.'),
  });

  if (zeroPropExportNames.length > 0) {
    findings.push({
      severity: 'warn',
      message: `${zeroPropExportNames.length}/${totalExports} exports (${round1(pctZeroProp)}%) have zero documented props: ${zeroPropExportNames.slice(0, 8).join(', ')}${zeroPropExportNames.length > 8 ? ', …' : ''}.`,
      // The docgen advice is wrong for a catalog the system's own compiler
      // emitted: Stencil's docs.json lists every @Prop() it compiled, so a
      // zero there is a real zero (a pure slot container like a button group),
      // not an extractor that lost them. Pointing a Stencil team at
      // "unresolved generics, forwardRef" would send them hunting a bug that
      // does not exist.
      fix:
        cfg.catalogStrategy === 'stencil'
          ? 'For a compiler-emitted catalog a zero is usually real: a pure slot/composition element with no @Prop(). Worth asking whether each is genuinely configuration-free, since an agent has nothing to steer it with.'
          : 'These are more likely docgen extraction gaps (unresolved generics, forwardRef, re-exported third-party types) than genuinely prop-less components. Spot-check a few before trusting the 0.',
    });
  }
  if (extractionSuspect) {
    findings.push({
      severity: 'warn',
      message: `extraction-suspect: ${round1(pctZeroProp)}% of exports have no props. Treat the coverage numbers below as a lower bound.`,
      fix: 'Type/description/default coverage below is computed only over the exports that did return props; fix extraction and re-run to get a true reading.',
    });
  }

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
  // coverage is. The formula is deliberately the same above the
  // extraction-suspect threshold: the loud finding is the correction, the
  // score still reflects the missing props honestly.
  const score =
    totalExports === 0 ? 0 : pctExportsWithProps * 0.25 + pctType * 0.35 + pctDescription * 0.25 + pctDefault * 0.15;

  return { id: 'catalog-quality', title: 'Catalog quality', score: round1(clamp(score, 0, 100)), findings };
}
