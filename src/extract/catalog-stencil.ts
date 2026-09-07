// "stencil" strategy: the system is a Stencil web-component library, and its
// own compiler already emits a complete machine-readable catalog — docs.json,
// from the `docs-json` output target. We read and normalize that, the same way
// the catalog-json strategy consumes a system's prebuilt react-docgen output.
//
// Why this needs its own strategy rather than a docgen tweak. A Stencil
// library breaks every assumption the docgen extractor is built on:
//
//   1. Its public barrel re-exports a *virtual* module. `src/index.ts` reads
//      `export * from './components'`, and `src/components` has no index file
//      on disk — the Stencil compiler synthesizes that module at build time.
//      The docgen barrel walk resolves re-export targets against the
//      filesystem, so it correctly reports the target as unresolvable and
//      finds zero component dirs. There is nothing to fix in the resolver:
//      the file genuinely is not there.
//   2. Components are classes with `@Prop()` decorators, not React function
//      components with a props interface, so react-docgen-typescript extracts
//      nothing from them even when pointed at the right files.
//   3. Component dirs nest arbitrarily deep under componentsSrc
//      (components/<group>/<tag>/, and deeper for sub-components), rather than
//      sitting one flat level down.
//
// Against that, docs.json hands us tags, prose docs, per-prop types, defaults,
// descriptions, and machine-readable deprecation for every component — a
// richer surface than docgen would have recovered from a React library. So the
// strategy is not a fallback; for a Stencil system it is the better source.
//
// Naming. A Stencil component has two public identities and models use both:
// the custom-element tag (`ds-button`, what you write in markup) and the
// PascalCase class the package exports (`DsButton`, what you import from the
// package barrel or a framework output target). Both are gradeable — they go
// into allExports/allPropsByExport with the same prop list, so a model is
// graded against the API it actually used rather than against whichever
// spelling this extractor happened to prefer.
//
// Only the tag becomes a `components[].exports` entry, though, and that
// asymmetry is deliberate: that array is the *documented* surface, and the
// audit's per-export checks read it directly. Emitting both spellings there
// doubled every export count and made docs-greppability report the PascalCase
// half as undocumented — which it always will be, because a Stencil system's
// prose documents the tag. The derived name is a real import path, not a
// second component.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { CatalogExport, CatalogProp, SystemCatalog, SystemConfig, SystemId } from '../types.ts';
import { buildIndexes, collectBarrelExports, gitCommit, hashPaths, mergeBarrelExports, resolveBarrelPath } from './normalize.ts';

// ---------------------------------------------------------------------------
// The subset of Stencil's docs.json we rely on
// ---------------------------------------------------------------------------

interface StencilDocsTag {
  name: string;
  text?: string;
}

interface StencilProp {
  name: string;
  /** Kebab-case attribute alias. Absent for object/function props, which have no attribute form. */
  attr?: string;
  type?: string;
  docs?: string;
  default?: string;
  required?: boolean;
  deprecation?: string;
  docsTags?: StencilDocsTag[];
}

interface StencilEvent {
  event: string;
  detail?: string;
  docs?: string;
  deprecation?: string;
}

interface StencilComponent {
  tag: string;
  /** Path to the component's .tsx, relative to the Stencil project root (the dir holding stencil.config.ts). */
  filePath?: string;
  docs?: string;
  docsTags?: StencilDocsTag[];
  deprecation?: string;
  props?: StencilProp[];
  events?: StencilEvent[];
}

interface StencilDocsJson {
  components?: StencilComponent[];
}

// ---------------------------------------------------------------------------
// Tag <-> class name
// ---------------------------------------------------------------------------

/**
 * Stencil's own tag-to-class rule: dash-delimited segments, each capitalized.
 * `ds-app-store-button` -> `DsAppStoreButton`. This is not a guess — it is the
 * name Stencil emits in dist/components/index.d.ts and in every framework
 * output target, so the derived name is exactly what a consumer imports.
 */
export function tagToClassName(tag: string): string {
  return tag
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * The React output target's prop name for a Stencil event: `toggled` ->
 * `onToggled`, `dsChange` -> `onDsChange`. Recorded alongside the real props
 * so a model wiring up an event handler in JSX is graded against a prop the
 * system genuinely accepts.
 */
function eventToHandlerProp(event: string): string {
  return `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;
}

// ---------------------------------------------------------------------------
// Component directory resolution
// ---------------------------------------------------------------------------

/**
 * docs.json `filePath` is relative to the Stencil project root, which is the
 * package dir (`packages/components`), while `componentsSrc` is relative to
 * the system root (`packages/components/src`). The two overlap by an unknown
 * number of leading segments, so rather than guessing the overlap we verify
 * it: strip leading segments one at a time until the remainder resolves to a
 * real directory under componentsSrc, and take the first that does.
 *
 * Falls back to the raw dirname when nothing resolves — a `dir` that doesn't
 * exist on disk is still a stable, honest grouping key, and is strictly better
 * than dropping the component.
 */
function componentDir(filePath: string | undefined, srcDir: string, tag: string): string {
  if (!filePath) return tag;
  const segments = dirname(filePath).split(/[\\/]/).filter((s) => s && s !== '.');
  for (let skip = 0; skip < segments.length; skip += 1) {
    const candidate = segments.slice(skip).join(sep);
    if (existsSync(join(srcDir, candidate))) return candidate;
  }
  return segments.join(sep) || tag;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

const COMPONENT_DECORATOR_RE = /@Component\s*\(/;
const TAG_FIELD_RE = /\btag\s*:\s*['"`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)['"`]/;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.turbo', '.cache']);
const MAX_SCANNED_FILES = 50_000;

/**
 * Every `.tsx` under `rootDir`, skipping vendor/build dirs and any
 * dot-directory. Local rather than shared: this is the only extractor that
 * needs a recursive source walk, and the audit's equivalent walker lives a
 * layer above this one (audit reads extract's output, not the reverse).
 * Best-effort — an unreadable directory contributes nothing rather than
 * throwing, and the file cap is a guard against a pathological tree.
 */
function walkTsxFiles(rootDir: string, out: string[] = []): string[] {
  if (out.length >= MAX_SCANNED_FILES) return out;
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCANNED_FILES) break;
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const abs = join(rootDir, entry.name);
    if (entry.isDirectory()) walkTsxFiles(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.tsx')) out.push(abs);
  }
  return out;
}

/**
 * Every custom-element tag declared under componentsSrc, found by a
 * deliberately dumb scan: any .tsx carrying an `@Component(` decorator, take
 * the first `tag: '...'` string after it. This is the same line-oriented
 * spirit as the token extractor — a real TS parse would buy nothing here,
 * since a Stencil component's tag is always a literal in a decorator object,
 * and a dumb scan can't be broken by a syntax the parser plugins don't cover.
 *
 * Unlike the catalog-json strategy's flat readdir of componentsSrc, this walks
 * recursively, because a Stencil library nests its components under grouping
 * directories that are not themselves components.
 */
function tagsOnDisk(srcDir: string): string[] {
  const tags = new Set<string>();
  for (const file of walkTsxFiles(srcDir)) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!COMPONENT_DECORATOR_RE.test(content)) continue;
    const decoratorIndex = content.search(COMPONENT_DECORATOR_RE);
    const match = TAG_FIELD_RE.exec(content.slice(decoratorIndex));
    if (match) tags.add(match[1]);
  }
  return [...tags].sort();
}

function checkStaleness(
  system: SystemId,
  cfg: SystemConfig,
  catalogTags: string[],
  allowStale: boolean | undefined,
): void {
  const srcDir = join(cfg.root, cfg.componentsSrc);
  const known = new Set(catalogTags);
  const missing = tagsOnDisk(srcDir).filter((tag) => !known.has(tag));
  if (missing.length === 0) return;

  const message =
    `${system} stencil docs.json (${cfg.catalogFile}) is stale: ${missing.length} ` +
    `custom element${missing.length === 1 ? '' : 's'} declared under ${cfg.componentsSrc} ` +
    `${missing.length === 1 ? 'is' : 'are'} not present in it: ${missing.join(', ')}. ` +
    `Regenerate it by building ${cfg.root} with the docs-json output target enabled.`;

  if (allowStale) {
    console.warn(`[extract:${system}] ${message}`);
  } else {
    throw new Error(message);
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function deprecationOf(item: { deprecation?: string; docsTags?: StencilDocsTag[] }): string | undefined {
  if (item.deprecation) return item.deprecation;
  const tag = item.docsTags?.find((t) => t.name === 'deprecated');
  return tag ? (tag.text ?? '') : undefined;
}

/**
 * Deprecation is carried in the description text rather than a dedicated
 * field, because CatalogExport/CatalogProp have no deprecation slot and this
 * is the form every downstream consumer already reads: the audit's
 * deprecation-legibility check greps for `@deprecated`, and the judge and the
 * written report see the note as prose. Prefixing (rather than appending)
 * keeps it visible when a description is truncated.
 */
function withDeprecation(description: string, deprecation: string | undefined): string {
  if (deprecation === undefined) return description;
  const note = deprecation ? `@deprecated ${deprecation}` : '@deprecated';
  return description ? `${note}\n\n${description}` : note;
}

function normalizeProps(component: StencilComponent): CatalogProp[] {
  return (component.props ?? []).map((p): CatalogProp => ({
    name: p.name,
    type: p.type ?? 'unknown',
    required: !!p.required,
    defaultValue: p.default == null ? undefined : String(p.default),
    description: withDeprecation(p.docs ?? '', deprecationOf(p)),
  }));
}

/**
 * Every spelling of this component's props that a consumer can legitimately
 * write, beyond the camelCase names already in `props`:
 *
 *   - the kebab-case attribute alias (`control-type` for `controlType`) — how
 *     the prop is set in HTML and in non-JSX templates;
 *   - the framework event-handler prop (`onToggled` for the `toggled` event) —
 *     how an event is wired up through a Stencil output target.
 *
 * These go into allPropsByExport but deliberately NOT into `props`, so the
 * apiFidelity grader accepts them while the catalog-quality check's per-prop
 * documentation coverage still measures the real, documented prop set rather
 * than being diluted by aliases that carry no independent docs.
 */
function propAliases(component: StencilComponent): string[] {
  const aliases: string[] = [];
  for (const p of component.props ?? []) {
    if (p.attr && p.attr !== p.name) aliases.push(p.attr);
  }
  for (const e of component.events ?? []) {
    aliases.push(eventToHandlerProp(e.event));
  }
  return aliases;
}

export async function extractStencilCatalog(
  system: SystemId,
  cfg: SystemConfig,
  opts?: { allowStale?: boolean },
): Promise<SystemCatalog> {
  if (!cfg.catalogFile) {
    throw new Error(
      `System config for "${system}" is missing catalogFile (required for the stencil strategy). ` +
        `Point it at the docs.json emitted by Stencil's docs-json output target, relative to root.`,
    );
  }
  const catalogPath = join(cfg.root, cfg.catalogFile);
  let raw: StencilDocsJson;
  try {
    raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as StencilDocsJson;
  } catch (err) {
    throw new Error(
      `could not read stencil docs.json at ${catalogPath}: ${(err as Error).message}. ` +
        `Build ${cfg.root} with the docs-json output target enabled to generate it.`,
    );
  }

  const stencilComponents = raw.components;
  if (!Array.isArray(stencilComponents)) {
    throw new Error(
      `${catalogPath} has no "components" array — this does not look like Stencil docs-json output. ` +
        `If it is this repo's own catalog shape, use catalogStrategy "catalog-json" instead.`,
    );
  }

  checkStaleness(system, cfg, stencilComponents.map((c) => c.tag), opts?.allowStale);

  const srcDir = join(cfg.root, cfg.componentsSrc);

  const components: SystemCatalog['components'] = stencilComponents.map((sc) => {
    const exports: CatalogExport[] = [
      {
        displayName: sc.tag,
        description: withDeprecation(sc.docs ?? '', deprecationOf(sc)),
        props: normalizeProps(sc),
      },
    ];
    return { dir: componentDir(sc.filePath, srcDir, sc.tag), exports };
  });

  const { allExports, allPropsByExport } = buildIndexes(components);

  // Everything else a consumer can legitimately write for these components:
  // the PascalCase class name (a second gradeable export, not a second
  // component — see the header note) and, for each spelling, the attribute and
  // event-handler prop aliases. All of it lands in the grading indexes only,
  // never in components[].exports.
  for (const sc of stencilComponents) {
    const documented = allPropsByExport[sc.tag] ?? [];
    const props = [...new Set([...documented, ...propAliases(sc)])];
    allPropsByExport[sc.tag] = props;

    const className = tagToClassName(sc.tag);
    if (!allPropsByExport[className]) allExports.push(className);
    allPropsByExport[className] = props;
  }

  // docs.json only covers custom elements. The package barrel additionally
  // exports runtime helpers (Stencil's own `setAssetPath`, loader entry
  // points) and re-exported types that consumers legitimately import, so merge
  // in whatever the barrel walk can reach. It will not reach the compiler's
  // virtual `./components` module — that is the whole reason this strategy
  // exists — but the statically-present exports around it are real, and
  // without them a grader flags correct usage as hallucination.
  const barrelPath = resolveBarrelPath(srcDir) ?? resolveBarrelPath(join(cfg.root, dirname(cfg.componentsSrc)));
  if (barrelPath) mergeBarrelExports(collectBarrelExports(barrelPath), allExports, allPropsByExport);

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

/** Exported for tests and for callers that want the on-disk tag set without a full extraction. */
export { tagsOnDisk, componentDir as resolveComponentDir };
