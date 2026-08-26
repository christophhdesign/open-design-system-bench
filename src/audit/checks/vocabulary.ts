// Tier-0 check 4: Vocabulary convention-distance. For every concept in the
// empirical convention lexicon (src/audit/convention-lexicon.json — the
// names four models actually reached for across 898 graded generations),
// classify the system's catalog into one of three states:
//
//   aligned   — the catalog exposes the lexicon's exact `expected` name for
//               this concept (component in allExports, or prop in some
//               component's props list).
//   distance  — the expected name is absent, but a documented alias for the
//               same concept IS present (e.g. the catalog has `Toggle`, not
//               `Switch` — see lexicon.ts's extractAliases). The concept is
//               covered, just under a different name — this is exactly the
//               "naming distance" this check measures.
//   n/a       — neither the expected name nor a known alias is present.
//               We can't tell whether that's a deliberate omission (no
//               Table component because the system isn't data-heavy) or a
//               true gap, so it's excluded from scoring rather than
//               penalized.
//
// Score = 100 * (1 - weighted distance ratio), where weight = the lexicon
// entry's `occurrences` (how often models invented that exact name across
// the mined sample) and the ratio is computed only over aligned+distance
// entries (n/a entries contribute no evidence either way).

import type { SystemCatalog, SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { loadCatalogForAudit } from '../catalog-loader.ts';
import { extractAliases, isIntentionallyAbsent, loadLexicon, type LexiconEntry } from '../lexicon.ts';
import { round1, clamp } from '../util.ts';

type Status = 'aligned' | 'distance' | 'n/a';

interface Classified {
  entry: LexiconEntry;
  kind: 'component' | 'prop';
  status: Status;
  matchedAlias?: string;
}

function componentPresent(name: string, catalog: SystemCatalog): boolean {
  return catalog.allExports.includes(name);
}

function propPresent(name: string, catalog: SystemCatalog): boolean {
  return Object.values(catalog.allPropsByExport).some((props) => props.includes(name));
}

function classify(entry: LexiconEntry, kind: 'component' | 'prop', catalog: SystemCatalog): Classified {
  if (isIntentionallyAbsent(entry)) return { entry, kind, status: 'n/a' };

  const present = kind === 'component' ? componentPresent : propPresent;
  if (present(entry.expected, catalog)) return { entry, kind, status: 'aligned' };

  for (const alias of extractAliases(entry.note)) {
    if (present(alias, catalog)) return { entry, kind, status: 'distance', matchedAlias: alias };
  }
  return { entry, kind, status: 'n/a' };
}

export async function checkVocabulary(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult> {
  const findings: AuditFinding[] = [];
  const load = await loadCatalogForAudit(system, cfg, dirs.catalogsDir);

  if (!load.catalog) {
    findings.push({
      severity: 'info',
      message: 'Vocabulary check skipped: no catalog available (needs one from catalog-quality\'s load path).',
    });
    return { id: 'vocabulary', title: 'Vocabulary convention-distance', score: null, findings };
  }

  const lexicon = loadLexicon();
  const classified: Classified[] = [
    ...lexicon.components.map((e) => classify(e, 'component', load.catalog!)),
    ...lexicon.props.map((e) => classify(e, 'prop', load.catalog!)),
  ];

  const aligned = classified.filter((c) => c.status === 'aligned');
  const distance = classified.filter((c) => c.status === 'distance');
  const na = classified.filter((c) => c.status === 'n/a');

  const scoredWeight = [...aligned, ...distance].reduce((sum, c) => sum + c.entry.occurrences, 0);
  const distanceWeight = distance.reduce((sum, c) => sum + c.entry.occurrences, 0);

  findings.push({
    severity: 'info',
    message: `${aligned.length} concept(s) aligned with convention, ${distance.length} covered under a different name, ${na.length} not represented in this catalog (n/a).`,
  });

  const topMismatches = [...distance].sort((a, b) => b.entry.occurrences - a.entry.occurrences).slice(0, 8);
  for (const m of topMismatches) {
    findings.push({
      severity: 'warn',
      message: `${m.kind === 'component' ? 'Component' : 'Prop'} "${m.entry.expected}" (${m.entry.concept}): models invented this name ${m.entry.occurrences} time(s) across the mined sample; this system covers it as "${m.matchedAlias}" instead.`,
      fix: m.entry.note ?? `Consider documenting "${m.entry.expected}" as an alias of "${m.matchedAlias}" in AGENTS.md so agents that reach for the convention name still land correctly.`,
    });
  }

  if (scoredWeight === 0) {
    findings.push({ severity: 'info', message: 'No lexicon concepts were detectable (aligned or aliased) in this catalog: vocabulary distance unmeasured.' });
    return { id: 'vocabulary', title: 'Vocabulary convention-distance', score: null, findings };
  }

  const score = 100 * (1 - distanceWeight / scoredWeight);
  return { id: 'vocabulary', title: 'Vocabulary convention-distance', score: round1(clamp(score, 0, 100)), findings };
}
