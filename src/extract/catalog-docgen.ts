// "docgen" strategy: for any typed React design system with no prebuilt
// machine catalog, extract one via react-docgen-typescript's
// withCompilerOptions() over each component's tsx entry file, using a
// propFilter that drops inherited @types/react / csstype / @radix-ui props.
// (We load and parse the tsconfig ourselves rather than use the higher-level
// withCustomConfig() — see loadCompilerOptions below — so that an unknown
// compiler option from a newer TypeScript doesn't hard-fail extraction.)
//
// There's no pre-enumerated component list, so we derive the public API
// ourselves by parsing the barrel (`<componentsSrc>/index.{ts,tsx,js,jsx,d.ts}`
// — see resolveBarrelPath in normalize.ts) with @babel/parser. Real-world
// barrels come in two shapes, and both are public API declarations:
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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import type { ExportSpecifier } from '@babel/types';
import { withCompilerOptions } from 'react-docgen-typescript';
import type { ComponentDoc, ParserOptions, PropItem } from 'react-docgen-typescript';
import ts from 'typescript';
import type { CatalogExport, CatalogProp, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import {
  buildIndexes,
  collectBarrelExports,
  expandSpecBases,
  gitCommit,
  hashPaths,
  mergeBarrelExports,
  resolveBarrelPath,
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
   * (`export { X } from './dir'`), PascalCase values only.
   */
  explicitNames?: string[];
  /**
   * True when an `export * from './dir'` names this dir: its module's own
   * export list governs IN ADDITION to any explicitNames. The two are not
   * redundant: `export { default as Accordion } from './Accordion'` next to
   * `export * from './Accordion'` (the MUI shape) puts the public PascalCase
   * name only in the parent's alias — the module's own list has just
   * `default` and camelCase helpers, so discarding explicitNames when the
   * export * resolves silently drops the component (field test: MUI fell
   * from 128 dirs to 12 the day the js resolver made those targets
   * resolvable).
   */
  broadened?: boolean;
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
      // JS-source systems (MUI ships src as .js + .d.ts): tried after the TS
      // flavors so TypeScript source always wins when both exist. Without
      // these, a dir holding only an index.js is silently skipped (field
      // test: four MUI export * targets like './Zoom' were lost).
      { path: join(abs, 'index.js'), isFileModule: false },
      { path: join(abs, 'index.jsx'), isFileModule: false },
      { path: `${abs}.js`, isFileModule: true },
      { path: `${abs}.jsx`, isFileModule: true },
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
    // Union, never discard: explicit names may be parent-side default
    // aliases the module's own export list cannot contain (see
    // BarrelDirEntry.broadened), and export * broadening is tracked as a
    // flag alongside them rather than replacing them.
    if (entry.broadened) existing.broadened = true;
    if (entry.explicitNames) {
      if (existing.explicitNames) existing.explicitNames.push(...entry.explicitNames);
      else existing.explicitNames = [...entry.explicitNames];
    }
  };

  // dir string relative to srcDir for a resolved target — may start with
  // '../' when the target lives outside srcDir but inside root.
  const dirFor = (target: ReexportTarget): string =>
    target.isFileModule ? relative(srcDir, target.path.replace(/\.(tsx|ts|mts|jsx|js)$/, '')) : relative(srcDir, dirname(target.path));

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
      add({ dir: dirFor(target), broadened: true });
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

/**
 * react-docgen-typescript reports `PropItem.parent.fileName` through its own
 * trimFileName() helper (see node_modules/react-docgen-typescript/lib/trimFileName.js),
 * which is NOT the same as the untouched absolute `ComponentDoc.filePath` we
 * pass to docgen ourselves. trimFileName walks upward from process.cwd()
 * (the "docgen project root" — wherever `extract` is invoked from) looking
 * for a filesystem ancestor shared with the prop's declaring file; when it
 * finds one at ancestor level k, it rewrites the path to be relative to that
 * ancestor's *parent* (preserving one directory name for readability). When
 * no shared ancestor exists (the common case for a component library
 * checked out somewhere unrelated to cwd, or in our own tests where fixtures
 * live under os.tmpdir()), it returns the original absolute path unchanged.
 *
 * So `parent.fileName` is either already absolute, or relative to the parent
 * of *some* ancestor of cwd — and we don't know which one. To reconstruct
 * it exactly, mirror the same upward walk from cwd and take the first
 * candidate that actually exists on disk (this inverts trimFileName's own
 * relative()/join() pairing at whichever level it matched). If nothing
 * resolves, we can't verify where the prop lives, so the caller treats it as
 * inherited rather than risk crediting a third-party prop as the system's
 * own documented API.
 */
function resolveParentFileName(fileName: string): string | undefined {
  if (isAbsolute(fileName)) return fileName;
  let dir = dirname(process.cwd());
  for (;;) {
    const candidate = resolve(dir, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root without a match
    dir = parent;
  }
}

/**
 * OWN when docgen gives no `parent` metadata at all (the prop is declared
 * directly on the component's own props type — react-docgen-typescript only
 * fills in `parent` for props inherited from an intersected/extended type),
 * or when `parent.fileName` resolves inside `srcDir`. INHERITED otherwise —
 * under node_modules, or anywhere else outside srcDir (a styled-system
 * spread, a polymorphic factory's generic base, a sibling shared-types dir,
 * ...). Only props that already survived `propFilter` reach this (that
 * filter unconditionally drops @types/react/csstype/@radix-ui regardless of
 * own/inherited status).
 */
// A parent type that contributes props to this many DISTINCT exports is
// shared infrastructure (a style-prop system, a polymorphic factory), not any
// single component's own API. The outside-srcDir rule alone cannot catch it:
// Chakra v3 generates SystemProperties INSIDE componentsSrc
// (src/styled-system/generated/system.gen.ts) and it feeds 700+ props to
// virtually every export, which is what ballooned the field-test catalog to
// 124 MB. 20 sits well above any real compound-component family and far
// below a real catalog's export count.
const SHARED_PARENT_EXPORT_THRESHOLD = 20;

// resolveParentFileName walks the filesystem per lookup; the same parent
// fileName repeats across hundreds of thousands of props in a big extract,
// so memoize (keys are stable within one process).
const parentResolveCache = new Map<string, string | undefined>();

/** Stable identity for a prop's declaring type: "<fileName>#<TypeName>". */
export function propParentKey(prop: Pick<PropItem, 'parent'>): string | undefined {
  return prop.parent ? `${prop.parent.fileName}#${prop.parent.name}` : undefined;
}

/**
 * Splits one export's docgen props into own (full metadata) and inherited
 * (name-only). A prop is inherited when its declaring type lives outside
 * componentsSrc (node_modules, a sibling package) OR is shared across at
 * least SHARED_PARENT_EXPORT_THRESHOLD distinct exports (in-tree style-prop
 * systems). No parent metadata means declared inline: own.
 */
export function splitOwnInherited(
  props: PropItem[],
  srcDir: string,
  exportCountByParent: Map<string, number>,
  threshold = SHARED_PARENT_EXPORT_THRESHOLD,
): { own: PropItem[]; inheritedNames: string[] } {
  const own: PropItem[] = [];
  const inheritedNames = new Set<string>();
  for (const prop of props) {
    const key = propParentKey(prop);
    if (!key) {
      own.push(prop);
      continue;
    }
    if ((exportCountByParent.get(key) ?? 0) >= threshold) {
      inheritedNames.add(prop.name);
      continue;
    }
    const fileName = prop.parent!.fileName;
    if (!parentResolveCache.has(fileName)) parentResolveCache.set(fileName, resolveParentFileName(fileName));
    const resolved = parentResolveCache.get(fileName);
    if (resolved && isInsideRoot(srcDir, resolved)) own.push(prop);
    else inheritedNames.add(prop.name);
  }
  return { own, inheritedNames: [...inheritedNames].sort() };
}

// react-docgen-typescript's withCustomConfig() reads and parses the tsconfig
// itself (ts.readConfigFile + ts.parseJsonConfigFileContent) and throws on
// the FIRST diagnostic parseJsonConfigFileContent reports, with no
// distinction between error categories — including "Unknown compiler
// option" errors. Design systems increasingly write tsconfig.json against
// whatever TypeScript version their own toolchain targets, which can be
// newer than the TS this bench bundles (5.9.3 as of writing); Primer's
// tsconfig sets `"stableTypeOrdering": true`, a TS 6.0 option, and that skew
// will only get more common as systems upgrade ahead of us. Loading the
// config ourselves lets us tell "I don't recognize this key" apart from a
// real config error, ignore only the former (with a warning naming the
// ignored option), and still fail loudly on the latter — then hand the
// resulting CompilerOptions to withCompilerOptions(), react-docgen-
// typescript's lower-level entry point that skips its own config parsing
// entirely.
function loadCompilerOptions(tsconfigPath: string): ts.CompilerOptions {
  const basePath = dirname(tsconfigPath);
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (error) {
    const message = typeof error.messageText === 'string' ? error.messageText : ts.flattenDiagnosticMessageText(error.messageText, '\n');
    throw new Error(`cannot load tsconfig.json at ${tsconfigPath}: ${message}`);
  }

  // basePath + tsconfigPath match withCustomConfig's own call shape, so
  // `extends` chains resolve exactly the same way (parseJsonConfigFileContent
  // walks `extends` itself; a missing extends target surfaces as its own
  // hard error below, e.g. TS5083 "Cannot read file").
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, basePath, {}, tsconfigPath);

  const ignoredOptionNames: string[] = [];
  const hardErrors: ts.Diagnostic[] = [];
  for (const diagnostic of parsed.errors) {
    // Verified against the installed TS version (see extract.test.ts): an
    // unknown key under "compilerOptions" reports as TS5023 ("Unknown
    // compiler option 'x'.") or, when TS finds a close match, TS5025
    // ("...Did you mean 'y'?") — both mean "I don't recognize this option"
    // and are exactly the version-skew case this exists to tolerate. TS5024
    // ("Compiler option 'x' requires a value of type y") is a genuine type
    // error on a *known* option and must still fail loudly, not be lumped in.
    if (diagnostic.code === 5023 || diagnostic.code === 5025) {
      const text = typeof diagnostic.messageText === 'string' ? diagnostic.messageText : ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const match = /Unknown compiler option '([^']+)'/.exec(text);
      ignoredOptionNames.push(match ? match[1] : text);
      continue;
    }
    hardErrors.push(diagnostic);
  }

  if (ignoredOptionNames.length > 0) {
    console.warn(
      `[extract] ${tsconfigPath}: ignoring unknown compiler option(s) ${ignoredOptionNames.join(', ')} — ` +
        `likely written for a newer TypeScript than this bench bundles (${ts.version})`,
    );
  }

  if (hardErrors.length > 0) {
    const first = hardErrors[0];
    const text = typeof first.messageText === 'string' ? first.messageText : ts.flattenDiagnosticMessageText(first.messageText, '\n');
    throw new Error(`invalid tsconfig.json at ${tsconfigPath}: TS${first.code}: ${text}`);
  }

  return parsed.options;
}

export async function extractDocgenCatalog(system: SystemId, cfg: SystemConfig): Promise<SystemCatalog> {
  const srcDir = join(cfg.root, cfg.componentsSrc);
  const barrelPath = resolveBarrelPath(srcDir);
  if (!barrelPath) {
    throw new Error(
      `no barrel entry point (index.ts, .tsx, .js, .jsx, or .d.ts) found in ${srcDir} — docgen extraction needs one to discover the public API`,
    );
  }
  const barrelDirs = collectBarrelDirs(barrelPath, srcDir, cfg.root);

  // dir -> ordered list of its public (PascalCase, value-exported) names.
  const dirToNames = new Map<string, string[]>();
  // dirs whose barrel entry names a bare .tsx module — docgen parses that file
  // directly instead of scanning a component directory for entry files.
  const fileModuleEntries = new Map<string, string>();
  const publicNames = new Set<string>();
  for (const { dir, explicitNames, broadened } of barrelDirs) {
    const target = resolveReexportTarget(srcDir, dir);
    if (!target && !explicitNames) {
      console.warn(`[extract:${system}] could not resolve re-export target for './${dir}' — skipping`);
      continue;
    }
    // A broadened dir owns its module's export list PLUS any parent-side
    // aliases; an explicit-only dir is exactly its alias list; a bare
    // export * dir is exactly its module's list.
    const moduleNames = broadened || !explicitNames ? (target ? collectPublicComponentNames(target.path) : []) : [];
    const names = [...new Set([...moduleNames, ...(explicitNames ?? [])])];
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
  const compilerOptions = loadCompilerOptions(tsconfigPath);
  const docgenParser = withCompilerOptions(compilerOptions, parserOptions);

  const components: SystemCatalog['components'] = [];
  const parentOwners = new Map<string, Set<string>>();
  const pendingSplits: Array<{ entry: CatalogExport; rawProps: PropItem[] }> = [];
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

        // The own/inherited split needs a GLOBAL view (the shared-parent
        // rule counts how many distinct exports a declaring type feeds), so
        // pass 1 only records the raw props and tallies parents; the split
        // itself happens once after every dir is parsed.
        const rawProps = Object.values(comp.props || {});
        const exportEntry: CatalogExport = {
          displayName: comp.displayName,
          description: (comp.description || '').trim(),
          props: [],
        };
        for (const prop of rawProps) {
          const key = propParentKey(prop);
          if (!key) continue;
          let owners = parentOwners.get(key);
          if (!owners) parentOwners.set(key, (owners = new Set()));
          owners.add(`${dir}#${comp.displayName}`);
        }
        pendingSplits.push({ entry: exportEntry, rawProps });
        exportsForDir.push(exportEntry);
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

  // Pass 2: with the full parent tally in hand, split every export's props.
  const exportCountByParent = new Map<string, number>();
  for (const [key, owners] of parentOwners) exportCountByParent.set(key, owners.size);
  for (const { entry, rawProps } of pendingSplits) {
    const { own, inheritedNames } = splitOwnInherited(rawProps, srcDir, exportCountByParent);
    entry.props = own.map(toCatalogProp);
    if (inheritedNames.length > 0) entry.inheritedProps = inheritedNames;
  }

  const { allExports, allPropsByExport } = buildIndexes(components);

  // buildIndexes only folds exp.props (own props only, post-split) into
  // allPropsByExport. Merge each export's inheritedProps names back in too —
  // allPropsByExport is the grading set the apiFidelity invented-prop check
  // keys off, and the own/inherited split must not shrink it.
  for (const comp of components) {
    for (const exp of comp.exports) {
      if (!exp.inheritedProps || exp.inheritedProps.length === 0) continue;
      const merged = new Set(allPropsByExport[exp.displayName] ?? []);
      for (const name of exp.inheritedProps) merged.add(name);
      allPropsByExport[exp.displayName] = [...merged];
    }
  }

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
