// "docgen" strategy: for any typed React design system with no prebuilt
// machine catalog, extract one via react-docgen-typescript's
// withCustomConfig() over each component's tsx entry file, using a propFilter
// that drops inherited @types/react / csstype / @radix-ui props.
//
// There's no pre-enumerated component list, so we derive the public API
// ourselves by parsing the barrel (`<componentsSrc>/index.ts`) with
// @babel/parser. Real-world barrels come in two shapes, and both are public
// API declarations:
//   - `export * from './<dir>'`: the
//     directory's own index module decides which of its value exports are
//     public (PascalCase, non-type) components.
//   - `export { X } from './<dir>'` (the dominant form in many systems):
//     the barrel itself names the public set; the specifier list is
//     authoritative for that directory.
// A barrel target may also be a bare .tsx file module rather than a directory
// (e.g. `export * from './components/Icon/Icon.Skeleton'`) — those are
// docgen-parsed directly.
//
// Monorepos (Chakra UI, Mantine, ...) add two wrinkles: the root barrel is
// often itself a barrel-of-barrels (`export * from './components'`, where
// `components/index.ts` re-exports each real component directory) — followed
// recursively rather than treated as one dir — and specifiers sometimes carry
// NodeNext-style `.js`/`.jsx` extensions that have to map back to `.ts(x)`
// source. A re-export that resolves outside componentsSrc but still inside
// the system root (a component living in a sibling package/dir) is followed
// rather than silently dropped.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import type { ExportSpecifier } from '@babel/types';
import { withCustomConfig } from 'react-docgen-typescript';
import type { ComponentDoc, ParserOptions, PropItem } from 'react-docgen-typescript';
import type { CatalogExport, CatalogProp, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import {
  buildIndexes,
  collectBarrelExports,
  expandSpecBases,
  gitCommit,
  hashPaths,
  mergeBarrelExports,
  resolveTsconfigUpward,
} from './normalize.ts';

function parseModule(code: string) {
  // 'jsx' matters: barrel targets can be implementation .tsx files, not just
  // re-export-only index files, and those must not crash the barrel walk.
  return parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
}

interface BarrelDirEntry {
  dir: string;
  /**
   * Names explicitly re-exported from the root barrel
   * (`export { X } from './dir'`), PascalCase values only. undefined when the
   * dir came from `export * from './dir'` — the dir's own module decides then.
   */
  explicitNames?: string[];
}

/** True when `absPath` is inside (or equal to) `root` — the boundary a followed re-export must stay within. */
function isInsideRoot(root: string, absPath: string): boolean {
  const rel = relative(resolve(root), resolve(absPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

interface ReexportTarget {
  path: string;
  /** true when the barrel entry names a bare module file (`./utils/cx`, `./Icon/Icon.Skeleton`) rather than a directory. */
  isFileModule: boolean;
}

/**
 * Resolves what `export ... from '<spec>'` actually points at, relative to
 * `baseDir` (the directory containing the file doing the exporting). Usually
 * `<spec>/index.ts(x)`, but barrel entries can also name a bare module file
 * directly rather than a directory. `spec` is the raw specifier
 * (`./components`, `./components/index.js`, `./Icon/Icon.Skeleton`) —
 * expandSpecBases handles NodeNext-style `.js`/`.jsx`/`.mjs` extensions
 * before candidate expansion.
 */
function resolveReexportTarget(baseDir: string, spec: string): ReexportTarget | undefined {
  for (const base of expandSpecBases(spec)) {
    const abs = join(baseDir, base);
    const candidates: ReexportTarget[] = [
      { path: join(abs, 'index.ts'), isFileModule: false },
      { path: join(abs, 'index.tsx'), isFileModule: false },
      { path: join(abs, 'index.mts'), isFileModule: false },
      { path: `${abs}.ts`, isFileModule: true },
      { path: `${abs}.tsx`, isFileModule: true },
      { path: `${abs}.mts`, isFileModule: true },
    ];
    for (const candidate of candidates) {
      try {
        readFileSync(candidate.path);
        return candidate;
      } catch {
        // try next candidate
      }
    }
  }
  // Literal fallback: a genuine compiled .js/.jsx file checked into source,
  // rather than assuming every .js-suffixed specifier maps to a .ts(x) source.
  const literal = join(baseDir, spec);
  try {
    readFileSync(literal);
    return { path: literal, isFileModule: true };
  } catch {
    return undefined;
  }
}

/**
 * True when `moduleFile`'s own top-level `export * from` targets resolve to
 * further directories rather than a sibling implementation file — i.e. it is
 * itself a pure barrel-of-barrels (e.g. a `components/index.ts` re-exporting
 * `./button`, `./accordion`, ...) rather than one component directory's own
 * index (`Alpha/index.ts` re-exporting its sibling `./Alpha` implementation
 * file). Determines whether collectBarrelDirs should recurse into it for
 * further dirs, or treat it as a single leaf component directory.
 */
function isBarrelOfDirs(moduleFile: string, root: string): boolean {
  const ast = parseModule(readFileSync(moduleFile, 'utf8'));
  const baseDir = dirname(moduleFile);
  for (const node of ast.program.body) {
    if (node.type !== 'ExportAllDeclaration') continue;
    if (typeof node.source.value !== 'string' || !node.source.value.startsWith('.')) continue;
    const target = resolveReexportTarget(baseDir, node.source.value);
    if (target && !target.isFileModule && isInsideRoot(root, target.path)) return true;
  }
  return false;
}

/** Strips a leading './' for display purposes — used only as a last-resort dir name when a barrel entry can't be resolved on disk (see collectBarrelDirs). */
function stripLeadingDotSlash(spec: string): string {
  return spec.startsWith('./') ? spec.slice(2) : spec;
}

/**
 * Every directory (or file module) the public barrel makes reachable,
 * de-duplicated by resolved location, in first-seen order. Follows both
 * `export * from './dir'` and named value re-exports
 * (`export { X } from './dir'`). Barrels commonly nest — a root `index.ts`
 * doing `export * from './components'` where `components/index.ts` then
 * re-exports each per-component directory — so `export *` chains are
 * followed recursively (isBarrelOfDirs decides, at each hop, whether the
 * target is a further barrel-of-dirs to recurse into or a leaf component
 * directory to record), with a visited-set cycle guard. When one dir is
 * named by both forms, the `export *` wins (its module's export list is a
 * superset of any explicit specifier list). A resolved target outside `root`
 * entirely is not followed (mirrors how a non-relative/external specifier is
 * never followed); a target outside `srcDir` but still inside `root` *is*
 * followed — silently dropping it is exactly the Mantine `Box` field-test bug
 * this exists to fix.
 */
function collectBarrelDirs(
  barrelPath: string,
  srcDir: string,
  root: string,
  visited: Set<string> = new Set(),
): BarrelDirEntry[] {
  if (visited.has(barrelPath)) return [];
  visited.add(barrelPath);

  const ast = parseModule(readFileSync(barrelPath, 'utf8'));
  const baseDir = dirname(barrelPath);
  const byDir = new Map<string, BarrelDirEntry>();

  const add = (entry: BarrelDirEntry) => {
    const existing = byDir.get(entry.dir);
    if (!existing) {
      byDir.set(entry.dir, entry);
      return;
    }
    if (!existing.explicitNames) return; // export * already governs this dir
    if (entry.explicitNames) existing.explicitNames.push(...entry.explicitNames);
    else existing.explicitNames = undefined; // export * broadens to the module's own export list
  };

  // dir string relative to srcDir for a resolved target — may start with
  // '../' when the target lives outside srcDir but inside root.
  const dirFor = (target: ReexportTarget): string =>
    target.isFileModule ? relative(srcDir, target.path.replace(/\.(tsx|ts|mts)$/, '')) : relative(srcDir, dirname(target.path));

  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') {
      if (typeof node.source.value !== 'string' || !node.source.value.startsWith('.')) continue;
      const target = resolveReexportTarget(baseDir, node.source.value);
      if (!target) {
        console.warn(`[extract] could not resolve re-export target '${node.source.value}' from ${barrelPath} — skipping`);
        continue;
      }
      if (!isInsideRoot(root, target.path)) continue; // stay inside the system root

      if (!target.isFileModule && isBarrelOfDirs(target.path, root)) {
        for (const nested of collectBarrelDirs(target.path, srcDir, root, visited)) add(nested);
        continue;
      }
      add({ dir: dirFor(target) });
      continue;
    }

    if (node.type !== 'ExportNamedDeclaration' || !node.source) continue;
    if (typeof node.source.value !== 'string' || !node.source.value.startsWith('.')) continue;
    if (node.exportKind === 'type') continue; // whole `export type { ... } from` block
    const names: string[] = [];
    for (const spec of node.specifiers) {
      if (spec.type !== 'ExportSpecifier') continue;
      const s = spec as ExportSpecifier;
      if (s.exportKind === 'type') continue; // inline `type X` within a mixed export list
      const exportedName = s.exported.type === 'Identifier' ? s.exported.name : s.exported.value;
      if (/^[A-Z]/.test(exportedName)) names.push(exportedName);
    }
    if (names.length === 0) continue;
    const target = resolveReexportTarget(baseDir, node.source.value);
    if (target && !isInsideRoot(root, target.path)) continue; // resolved but outside the system root — don't follow

    // Even when the target can't be found on disk, the barrel's own naming
    // is used as a best-effort dir key — the specifier list is authoritative
    // regardless of whether docgen will later find any .tsx files there.
    const dir = target ? dirFor(target) : stripLeadingDotSlash(node.source.value);
    add({ dir, explicitNames: names });
  }

  return [...byDir.values()];
}

/**
 * PascalCase, value-exported (non-type) names a dir's own index/module file
 * makes public — via re-export specifiers or inline
 * `export const/function/class` declarations (file modules like an
 * `Icon.Skeleton.tsx` declare their component inline).
 */
function collectPublicComponentNames(moduleFile: string, visited: Set<string> = new Set()): string[] {
  if (visited.has(moduleFile)) return [];
  visited.add(moduleFile);

  const ast = parseModule(readFileSync(moduleFile, 'utf8'));
  const baseDir = dirname(moduleFile);
  const names: string[] = [];
  for (const node of ast.program.body) {
    if (node.type === 'ExportAllDeclaration') {
      // A dir's own index sometimes re-exports its sibling implementation
      // file wholesale (`export * from './Alpha'`) instead of naming
      // components explicitly — follow it (with a cycle guard) to reach the
      // inline declarations, same as collectBarrelExports does for allExports.
      if (typeof node.source.value !== 'string' || !node.source.value.startsWith('.')) continue;
      const target = resolveReexportTarget(baseDir, node.source.value);
      if (target) names.push(...collectPublicComponentNames(target.path, visited));
      continue;
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.exportKind === 'type') continue; // whole `export type { ... }` block
    if (node.declaration) {
      const decl = node.declaration;
      if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id && /^[A-Z]/.test(decl.id.name)) {
        names.push(decl.id.name);
      } else if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations) {
          if (d.id.type === 'Identifier' && /^[A-Z]/.test(d.id.name)) names.push(d.id.name);
        }
      }
      continue;
    }
    for (const spec of node.specifiers) {
      if (spec.type !== 'ExportSpecifier') continue;
      const s = spec as ExportSpecifier;
      if (s.exportKind === 'type') continue; // inline `type X` within a mixed export list
      const exportedName = s.exported.type === 'Identifier' ? s.exported.name : s.exported.value;
      if (/^[A-Z]/.test(exportedName)) names.push(exportedName);
    }
  }
  return names;
}

/**
 * Kebab-case, single-segment subpath keys from a package.json's "exports"
 * map — e.g. "./toggle" -> "toggle". Skips the root "." key and multi-segment
 * / wildcard keys like "./utils/cx" or "./assets/*" (those aren't
 * independent public component dirs).
 */
function collectPackageJsonSubpathDirs(pkgJsonPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(pkgJsonPath, 'utf8');
  } catch {
    return [];
  }
  let pkg: { exports?: unknown };
  try {
    pkg = JSON.parse(raw) as { exports?: unknown };
  } catch {
    return [];
  }
  const exportsField = pkg.exports;
  if (!exportsField || typeof exportsField !== 'object') return [];
  return Object.keys(exportsField)
    .filter((key) => /^\.\/[a-zA-Z0-9-]+$/.test(key))
    .map((key) => key.slice(2));
}

/** Non-spec, non-figma .tsx files directly inside a component directory (docgen entry candidates). */
function listEntryTsxFiles(componentDirPath: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(componentDirPath);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.tsx') && !f.includes('.spec.') && !f.includes('.figma.'))
    .sort()
    .map((f) => join(componentDirPath, f));
}

function flattenDefaultValue(defaultValue: unknown): string | undefined {
  if (defaultValue == null) return undefined;
  if (typeof defaultValue === 'object' && 'value' in (defaultValue as Record<string, unknown>)) {
    const v = (defaultValue as { value?: unknown }).value;
    return v == null ? undefined : String(v);
  }
  return String(defaultValue);
}

function toCatalogProp(prop: PropItem): CatalogProp {
  return {
    name: prop.name,
    type: (prop.type && (prop.type.raw || prop.type.name)) || '',
    required: !!prop.required,
    defaultValue: flattenDefaultValue(prop.defaultValue),
    description: (prop.description || '').trim(),
  };
}

// Keep component-declared props, drop ones inherited purely from DOM/React/
// Radix typings so the catalog stays focused on the component's own API surface.
const propFilter: ParserOptions['propFilter'] = (prop) => {
  const fileName = prop.parent?.fileName || '';
  if (fileName.includes('@types/react')) return false;
  if (fileName.includes('csstype')) return false;
  if (fileName.includes('@radix-ui')) return false;
  return true;
};

const parserOptions: ParserOptions = {
  savePropValueAsString: true,
  shouldExtractLiteralValuesFromEnum: true,
  shouldRemoveUndefinedFromOptional: true,
  propFilter,
};

export async function extractDocgenCatalog(system: SystemId, cfg: SystemConfig): Promise<SystemCatalog> {
  const srcDir = join(cfg.root, cfg.componentsSrc);
  const barrelPath = join(srcDir, 'index.ts');
  const barrelDirs = collectBarrelDirs(barrelPath, srcDir, cfg.root);

  // dir -> ordered list of its public (PascalCase, value-exported) names.
  const dirToNames = new Map<string, string[]>();
  // dirs whose barrel entry names a bare .tsx module — docgen parses that file
  // directly instead of scanning a component directory for entry files.
  const fileModuleEntries = new Map<string, string>();
  const publicNames = new Set<string>();
  for (const { dir, explicitNames } of barrelDirs) {
    const target = resolveReexportTarget(srcDir, dir);
    if (!target && !explicitNames) {
      console.warn(`[extract:${system}] could not resolve re-export target for './${dir}' — skipping`);
      continue;
    }
    const names = explicitNames ? [...new Set(explicitNames)] : collectPublicComponentNames(target!.path);
    dirToNames.set(dir, names);
    for (const n of names) publicNames.add(n);
    if (target?.isFileModule && target.path.endsWith('.tsx')) fileModuleEntries.set(dir, target.path);
  }

  // The public API is the root barrel UNION the package's own subpath
  // exports. A few dirs sometimes have a proper per-dir index.ts and a
  // "./<dir>" entry in the components package's "exports" map, but aren't
  // re-exported from the root barrel — so the barrel walk above misses them
  // entirely. These dirs aren't reachable via `export *` chains from the root
  // barrel, so (unlike barrel dirs) their full value+type export list has to
  // be merged in separately at the end — collect their index.ts paths for that.
  const packageOnlySubpathIndexFiles: string[] = [];
  const pkgJsonPath = join(dirname(srcDir), 'package.json');
  for (const dir of collectPackageJsonSubpathDirs(pkgJsonPath)) {
    if (dirToNames.has(dir)) continue; // already covered by the barrel walk
    const target = resolveReexportTarget(srcDir, dir);
    if (!target) continue;

    const names = collectPublicComponentNames(target.path);
    dirToNames.set(dir, names);
    for (const n of names) publicNames.add(n);
    if (target.isFileModule && target.path.endsWith('.tsx')) fileModuleEntries.set(dir, target.path);
    packageOnlySubpathIndexFiles.push(target.path);
  }

  const tsconfigPath = resolveTsconfigUpward(srcDir, cfg.root);
  const docgenParser = withCustomConfig(tsconfigPath, parserOptions);

  const components: SystemCatalog['components'] = [];
  for (const [dir, names] of dirToNames) {
    if (names.length === 0) continue; // e.g. utils/cx, utils/is-react-component: no public components
    const fileModule = fileModuleEntries.get(dir);
    const tsxFiles = fileModule ? [fileModule] : listEntryTsxFiles(join(srcDir, dir));

    const orderIndex = new Map(names.map((n, i) => [n, i]));
    const covered = new Set<string>();
    const exportsForDir: CatalogExport[] = [];

    for (const file of tsxFiles) {
      let parsed: ComponentDoc[];
      try {
        parsed = docgenParser.parse(file);
      } catch (err) {
        console.warn(`[extract:${system}] docgen parse failed for ${file}: ${(err as Error).message}`);
        continue;
      }
      for (const comp of parsed) {
        if (!publicNames.has(comp.displayName)) continue; // internal/unexported helper — not public API
        if (covered.has(comp.displayName)) continue; // same file appearing via multiple entry tsx (shouldn't happen, but be safe)
        covered.add(comp.displayName);
        exportsForDir.push({
          displayName: comp.displayName,
          description: (comp.description || '').trim(),
          props: Object.values(comp.props || {}).map(toCatalogProp),
        });
      }
    }

    // Every barrel-declared component name still needs to be a first-class
    // catalog entry even when docgen produced nothing for it — no tsx found,
    // a parse failure, or a shape react-docgen-typescript doesn't recognize.
    // The symbol is real and part of the public API; only its prop table is
    // unverified.
    for (const name of names) {
      if (covered.has(name)) continue;
      exportsForDir.push({
        displayName: name,
        description: 'docgen could not extract props',
        props: [],
      });
    }

    exportsForDir.sort((a, b) => (orderIndex.get(a.displayName) ?? 0) - (orderIndex.get(b.displayName) ?? 0));
    components.push({ dir, exports: exportsForDir });
  }

  const { allExports, allPropsByExport } = buildIndexes(components);

  // components/allPropsByExport above only cover docgen-documentable
  // components. The public API is bigger — hooks, variant-class helpers
  // (`buttonVariants`), and every re-exported TYPE (`ButtonProps`) — so walk
  // the full barrel (following `export *` chains) and merge in anything
  // still missing with an empty prop list. Package.json-only subpath dirs
  // aren't reachable from the root barrel walk at all, so their own index.ts
  // files are walked the same way and merged in alongside it.
  const fullExports = collectBarrelExports(barrelPath);
  for (const indexPath of packageOnlySubpathIndexFiles) {
    fullExports.push(...collectBarrelExports(indexPath));
  }
  mergeBarrelExports(fullExports, allExports, allPropsByExport);

  return {
    system,
    generatedAt: new Date().toISOString(),
    source: {
      root: cfg.root,
      commit: gitCommit(cfg.root),
      srcHash: hashPaths(cfg.root, [cfg.componentsSrc]),
    },
    components,
    allExports,
    allPropsByExport,
  };
}
