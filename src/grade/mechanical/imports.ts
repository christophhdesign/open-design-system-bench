// Dimension: imports (weight .10)
// Flags any import source that isn't the system's own packages, React/Vite
// infrastructure, a relative import, or an explicitly task-allowlisted extra.

import type { DimensionResult, Diff, Gate } from '../../types.ts';
import type { GradeContext } from '../context.ts';

const REACT_PREFIXES = ['react', 'react-dom'];
const VITE_PREFIXES = ['vite'];

function isRelative(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../');
}

function matchesPkg(source: string, pkg: string): boolean {
  return source === pkg || source.startsWith(`${pkg}/`);
}

function matchesPrefixList(source: string, prefixes: string[]): boolean {
  return prefixes.some((p) => source === p || source.startsWith(`${p}/`));
}

function isAllowed(source: string, ctx: GradeContext): boolean {
  if (isRelative(source)) return true;
  if (matchesPkg(source, ctx.systemCfg.componentsPkg)) return true;
  if (matchesPkg(source, ctx.systemCfg.foundationsPkg)) return true;
  if (matchesPrefixList(source, REACT_PREFIXES)) return true;
  if (matchesPrefixList(source, VITE_PREFIXES)) return true;
  const extra = ctx.task.mechanicalOverrides?.extraAllowedImports ?? [];
  if (matchesPrefixList(source, extra)) return true;
  return false;
}

export function gradeImports(ctx: GradeContext): DimensionResult {
  const diffs: Diff[] = [];
  let violations = 0;

  for (const file of ctx.files) {
    for (const imp of file.analysis.imports) {
      if (isAllowed(imp.source, ctx)) continue;
      violations += 1;
      diffs.push({
        dimension: 'imports',
        message: `Disallowed import '${imp.source}' in ${file.path}`,
        fix: `Use ${ctx.systemCfg.componentsPkg} (or ${ctx.systemCfg.foundationsPkg}) or a relative import instead of '${imp.source}'.`,
      });
    }
  }

  const score = Math.max(0, 100 - violations * 25);
  const gate: Gate = violations === 0 ? 'pass' : violations === 1 ? 'review' : 'fail';

  return { dimension: 'imports', score, gate, diffs };
}
