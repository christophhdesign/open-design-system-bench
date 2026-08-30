// Re-derivation of citedFigures.
//
// A citedFigure is a number the agent worked out by reading something the
// harness does not compute: "ten exports expose a `variant` prop", "252
// references in text-styles.json". Declaring the source and method is the
// minimum bar, and it is what a human analyst's footnote does.
//
// Where the source is an artifact the harness already parses, we can do better
// than trust the footnote: recompute the value and fail on a mismatch. That
// covers the most common shape of cited figure, and it is exactly the shape an
// agent gets wrong, since it means counting entries in a long list.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemCatalog, SystemId } from '../types.ts';

/** Machine-checkable recipes. Extend this union rather than loosening the check. */
export type FigureDerivation = { kind: 'exportsWithProp'; prop: string };

export interface DerivationContext {
  catalog: SystemCatalog | null;
}

export interface DerivationOutcome {
  /** null when the recipe could not be run, e.g. the catalog has not been extracted here. */
  value: number | null;
  /** Why it could not run, for a warning the author can act on. */
  unavailable?: string;
}

export function loadCatalogIfPresent(catalogsDir: string, system: SystemId): SystemCatalog | null {
  const path = join(catalogsDir, `${system}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SystemCatalog;
  } catch {
    return null;
  }
}

/**
 * Recomputes a declared figure. Counts against `allPropsByExport`, which is the
 * extractor's own view of the public API, so the number a report quotes is the
 * number the grader used.
 */
export function deriveFigure(derivation: FigureDerivation, ctx: DerivationContext): DerivationOutcome {
  switch (derivation.kind) {
    case 'exportsWithProp': {
      if (!ctx.catalog) {
        return { value: null, unavailable: 'no extracted catalog is available here (run `extract`)' };
      }
      const count = Object.values(ctx.catalog.allPropsByExport).filter((props) =>
        props.includes(derivation.prop),
      ).length;
      return { value: count };
    }
    default:
      return { value: null, unavailable: 'unknown derivation kind' };
  }
}

/** One-line human description, used in validate output. */
export function describeDerivation(derivation: FigureDerivation): string {
  switch (derivation.kind) {
    case 'exportsWithProp':
      return `exports declaring a prop named "${derivation.prop}"`;
    default:
      return 'unknown derivation';
  }
}
