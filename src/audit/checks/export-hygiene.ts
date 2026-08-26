// Tier-0 check 3: Export hygiene. Public API = root barrel UNION
// package.json's exports map — the same rule src/extract/normalize.ts's
// collectBarrelExports encodes, because building this benchmark found three
// real components with a proper per-dir index.ts that were reachable
// through neither: invisible to consumers who `import { X } from
// '@scope/components'`, and invisible to consumers who import a subpath
// directly. This check re-runs that specific diff standalone, as a static
// audit finding rather than a hard extract-time failure.
//
// Also reports two smaller, cheap-to-check hygiene signals: whether the
// components package.json declares a `types`/`typings` field, and whether
// its declared entry points (main/module/exports["."]) point at a built
// `dist/` rather than raw `src/` (a package that "works" only inside its own
// monorepo via source aliasing is not usable by an external agent workspace).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import type { SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { findPackageDir, readJsonSafe, round1, clamp } from '../util.ts';

interface PkgJson {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: Record<string, unknown>;
}

function parseModule(code: string) {
  // 'jsx' matters: a barrel that re-exports implementation .tsx files must not
  // parse-fail into an empty set (which would flag every dir unreachable).
  return parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
}

/**
 * Directories the root barrel makes reachable as VALUES: `export * from
 * './dir'` plus named value re-exports (`export { X } from './dir'` — the
 * dominant form in several widely used barrels). A type-only re-export
 * (`export type { XProps } from './dir'`) deliberately does not count: the
 * component value is still not importable from the root, which is exactly the
 * bug class this check exists for.
 */
function collectBarrelReachableDirs(barrelPath: string): Set<string> {
  const dirs = new Set<string>();
  let code: string;
  try {
    code = readFileSync(barrelPath, 'utf8');
  } catch {
    return dirs;
  }
  let ast: ReturnType<typeof parseModule>;
  try {
    ast = parseModule(code);
  } catch {
    return dirs;
  }
  const addSource = (value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith('./')) return;
    dirs.add(value.slice(2).replace(/\/index$/, ''));
  };
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') {
      addSource(node.source.value);
      continue;
    }
    if (node.type !== 'ExportNamedDeclaration' || !node.source || node.exportKind === 'type') continue;
    const hasValueSpecifier = node.specifiers.some((s) => s.type === 'ExportSpecifier' && s.exportKind !== 'type');
    if (hasValueSpecifier) addSource(node.source.value);
  }
  return dirs;
}

/** Single-segment subpath keys from package.json's exports map: "./toggle" -> "toggle". */
function collectExportsMapDirs(exportsField: Record<string, unknown> | undefined): Set<string> {
  const dirs = new Set<string>();
  if (!exportsField) return dirs;
  for (const key of Object.keys(exportsField)) {
    const m = /^\.\/([a-zA-Z0-9-]+)$/.exec(key);
    if (m) dirs.add(m[1]);
  }
  return dirs;
}

/**
 * Directory names that conventionally declare "not public API on purpose".
 * An index.ts inside internal/ or private/ is deliberate encapsulation
 * — flagging it would punish the opposite
 * of this check's target bug class (components unexported by accident).
 */
const ENCAPSULATED_DIR_NAMES = new Set(['internal', 'private']);

/** Component-dir candidates directly under componentsSrc: any subdirectory containing its own index.ts(x), minus conventionally-private names. */
function collectComponentDirsWithIndex(srcDir: string): { candidates: string[]; encapsulated: string[] } {
  let entries;
  try {
    entries = readdirSync(srcDir, { withFileTypes: true });
  } catch {
    return { candidates: [], encapsulated: [] };
  }
  const withIndex = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(srcDir, name, 'index.ts')) || existsSync(join(srcDir, name, 'index.tsx')))
    .sort();
  return {
    candidates: withIndex.filter((name) => !ENCAPSULATED_DIR_NAMES.has(name)),
    encapsulated: withIndex.filter((name) => ENCAPSULATED_DIR_NAMES.has(name)),
  };
}

function pointsAtDist(value: string | undefined): boolean {
  return !!value && /(^|\/)dist\//.test(value);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- dirs unused: this check reads componentsSrc/package.json directly, no catalog needed; kept for AuditCheckFn conformance.
export async function checkExportHygiene(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult> {
  const findings: AuditFinding[] = [];
  const root = cfg.root;
  const srcDir = join(root, cfg.componentsSrc);
  const barrelPath = join(srcDir, 'index.ts');

  const barrelDirs = collectBarrelReachableDirs(barrelPath);
  const pkgDir = findPackageDir(srcDir, root);
  const pkg = pkgDir ? readJsonSafe<PkgJson>(join(pkgDir, 'package.json')) : undefined;
  const exportsMapDirs = collectExportsMapDirs(pkg?.exports);
  const { candidates: componentDirs, encapsulated } = collectComponentDirsWithIndex(srcDir);
  for (const dir of encapsulated) {
    findings.push({ severity: 'info', message: `${dir}/ has its own index.ts but is treated as intentionally non-public (conventional name) and excluded from reachability.` });
  }

  if (!existsSync(barrelPath)) {
    findings.push({ severity: 'warn', message: `No root barrel found at ${cfg.componentsSrc}/index.ts.` });
  }
  if (!pkgDir) {
    findings.push({ severity: 'warn', message: `Could not locate the components package.json above ${cfg.componentsSrc}.` });
  }

  const unreachable = componentDirs.filter((d) => !barrelDirs.has(d) && !exportsMapDirs.has(d));
  for (const dir of unreachable) {
    findings.push({
      severity: 'fail',
      message: `${dir}/ has its own index.ts but is not reachable via the root barrel or package.json exports.`,
      fix: `Add "export * from './${dir}'" (or a named value re-export) to ${cfg.componentsSrc}/index.ts, or a "./${dir}" entry to the exports map. This is the exact bug class that motivated this check: it was found in a production design system while building the harness.`,
    });
  }

  const reachableCount = componentDirs.length - unreachable.length;
  const reachabilityPct = componentDirs.length > 0 ? (reachableCount / componentDirs.length) * 100 : 100;

  const hasTypes = !!(pkg?.types || pkg?.typings);
  if (!hasTypes) {
    findings.push({ severity: 'warn', message: 'package.json has no "types"/"typings" field.', fix: 'Declare "types" so TypeScript-aware agent tooling can resolve prop types without a docgen catalog.' });
  }

  const distDeclared =
    pointsAtDist(pkg?.main) || pointsAtDist(pkg?.module) || pointsAtDist(pkg?.exports?.['.'] as string | undefined);
  if (!distDeclared) {
    findings.push({
      severity: 'info',
      message: 'No declared entry point (main/module/exports["."]) points at a built dist/ path.',
      fix: 'A package usable outside its own monorepo (by an external agent workspace via npm install) needs a built dist entry, not source-aliased paths.',
    });
  }

  if (componentDirs.length === 0) {
    findings.push({ severity: 'info', message: `No component directories with an index.ts found under ${cfg.componentsSrc}.` });
  } else {
    findings.push({ severity: 'info', message: `${reachableCount}/${componentDirs.length} component director${componentDirs.length === 1 ? 'y is' : 'ies are'} reachable via the barrel or exports map.` });
  }

  // Weights: reachability is the headline signal this check exists for (70);
  // types + dist usability are secondary "can an external agent even consume
  // this package" signals (15 each).
  const score = componentDirs.length > 0 ? reachabilityPct * 0.7 + (hasTypes ? 15 : 0) + (distDeclared ? 15 : 0) : hasTypes ? 60 : 30;

  return { id: 'export-hygiene', title: 'Export hygiene', score: round1(clamp(score, 0, 100)), findings };
}
