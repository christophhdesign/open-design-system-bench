// Fixture workspace lifecycle: prepare the shared per-system template (npm
// install once), provision a disposable per-cell workspace from it (copy +
// symlinked node_modules + context injection + baseline git commit), and
// prune a workspace's node_modules symlink once a cell is done with it.
//
// Two consume modes (SystemConfig.consume, default 'source'):
//   - 'source': the template apps under fixtures/<systemId>-app (or
//     SystemConfig.fixtureTemplate, for a stranger pointing at their own
//     template) consume the system FROM SOURCE (aliased straight at the
//     system's source dir via __SYSTEM_ROOT__ substitution, no build step) so
//     an agent's edits are checked against the same source tree the system
//     ships.
//   - 'npm': the generic fixtures/npm-app template is copied into a
//     per-system prepared dir (fixtures/.prepared/<systemId>-app) and
//     SystemConfig.packageSpec (or componentsPkg) is npm-installed there —
//     for systems that only exist as a published package, with no local
//     source checkout to alias against. provisionWorkspace works from that
//     prepared dir exactly as it does for 'source' mode; imports resolve
//     through the prepared dir's real node_modules, so no __SYSTEM_ROOT__
//     substitution is needed.

import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { PKG_ROOT, paths } from '../config.ts';
import type { ContextLevel, SystemCatalog, SystemConfig, SystemId } from '../types.ts';

const execFileAsync = promisify(execFile);

const NPM_CACHE_DIR = join(PKG_ROOT, '.npm-cache');
const SYSTEM_ROOT_PLACEHOLDER = '__SYSTEM_ROOT__';
const COMPONENTS_PKG_PLACEHOLDER = '__COMPONENTS_PKG__';
const FOUNDATIONS_PKG_PLACEHOLDER = '__FOUNDATIONS_PKG__';
// Where the components/foundations actually sit inside __SYSTEM_ROOT__ — filled
// from the system's own componentsSrc / foundationsCss config, so source-app
// works for any repo layout, not just packages/components/src.
const COMPONENTS_SRC_PLACEHOLDER = '__COMPONENTS_SRC__';
const FOUNDATIONS_CSS_PLACEHOLDER = '__FOUNDATIONS_CSS__';
// Substituted into tsconfig/vite.config's __FOUNDATIONS_CSS__ path segment when
// the system has no foundationsCss configured. Never actually resolved: the
// corresponding import is dropped from main.tsx by applyFoundationsCssPlaceholder,
// so this is a harmless, self-explaining dead mapping rather than a real path.
const FOUNDATIONS_CSS_FALLBACK = 'foundations-css-not-configured.css';

/**
 * The one foundations stylesheet this template can alias, or undefined when
 * there is none. `foundationsCss` may name several files — a system that
 * splits tokens one file per category with no aggregate entry point (see
 * config.ts) — and the extractor and the audit read those as a single
 * concatenated document. This template cannot: `<foundationsPkg>/index.css`
 * resolves to exactly one path under the system's own checkout, and a fixture
 * has no business writing an aggregate into someone else's repo to invent one.
 * So a multi-file system provisions the way a system with no foundationsCss
 * does, dead alias and no import, which costs the fixture its stylesheet but
 * not its grade: every dimension reads source text, not rendered CSS.
 */
function aliasableFoundationsCss(cfg: SystemConfig): string | undefined {
  const raw = cfg.foundationsCss;
  if (!raw) return undefined;
  if (!Array.isArray(raw)) return raw;
  return raw.length === 1 ? raw[0] : undefined;
}
const SUBSTITUTED_FILES = [
  'vite.config.ts',
  'tsconfig.json',
  'index.html',
  'src/App.tsx',
  'src/main.tsx',
  // custom-elements-app only: the ambient declaration for componentsPkg.
  'src/system-module.d.ts',
];
const CSS_ENTRY_PLACEHOLDER = '__CSS_ENTRY__';
const FOUNDATIONS_CSS_ENTRY_PLACEHOLDER = '__FOUNDATIONS_CSS_ENTRY__';

/**
 * Shared implementation behind applyCssEntryPlaceholder (npm mode) and
 * applyFoundationsCssPlaceholder (source mode): rewrites (importSpecifier set)
 * or removes (importSpecifier absent) a single `import '<placeholder>';` line
 * in destDir/src/main.tsx. No-op if the file, or that exact line, is absent.
 */
function applyImportLinePlaceholder(destDir: string, placeholder: string, importSpecifier: string | undefined): void {
  const mainPath = join(destDir, 'src', 'main.tsx');
  if (!existsSync(mainPath)) return;
  const content = readFileSync(mainPath, 'utf8');
  const placeholderLine = `import '${placeholder}';\n`;
  if (!content.includes(placeholderLine)) return;
  const next = importSpecifier
    ? content.replace(placeholderLine, `import '${importSpecifier}';\n`)
    : content.replace(placeholderLine, '');
  writeFileSync(mainPath, next, 'utf8');
}

const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org/';
const npmInstallArgs = (extra: string[] = []) => [
  'install',
  ...extra,
  '--registry',
  PUBLIC_NPM_REGISTRY,
  '--cache',
  NPM_CACHE_DIR,
  '--no-fund',
  '--no-audit',
];

/**
 * The system's fixture template dir. 'npm' consume mode always resolves to its
 * per-system prepared dir (fixtures/.prepared/<systemId>-app, built by
 * prepareTemplate's npm branch). 'source' mode resolves in order:
 *   1. SystemConfig.fixtureTemplate, when set
 *   2. fixtures/<systemId>-app, when a team has hand-rolled one
 *   3. fixtures/source-app, the generic template
 *   3. fixtures/custom-elements-app when componentModel is 'custom-elements',
 *      else fixtures/source-app
 * Step 3 is what makes source mode work out of the box: the generic template
 * carries __SYSTEM_ROOT__ / __COMPONENTS_PKG__ / __FOUNDATIONS_PKG__
 * placeholders that provisionWorkspace fills in from the system's own config.
 * A web-component system cannot use the React template: its exports are
 * element classes rather than components, and consumers write tags instead of
 * importing anything per component.
 */
export function templateDir(system: SystemId, cfg: SystemConfig): string {
  if (cfg.consume === 'npm') return preparedNpmDir(system);
  if (cfg.fixtureTemplate) return resolve(PKG_ROOT, cfg.fixtureTemplate);
  const perSystem = join(paths.fixturesDir, `${system}-app`);
  if (existsSync(perSystem)) return perSystem;
  if (cfg.componentModel === 'custom-elements') return join(paths.fixturesDir, 'custom-elements-app');
  return join(paths.fixturesDir, 'source-app');
}

/** Source dir for the generic npm-consume template: SystemConfig.fixtureTemplate if set, else the built-in fixtures/npm-app. */
export function npmTemplateSourceDir(cfg: SystemConfig): string {
  return cfg.fixtureTemplate ? resolve(PKG_ROOT, cfg.fixtureTemplate) : join(paths.fixturesDir, 'npm-app');
}

/** Per-system prepared dir for 'npm' consume mode (gitignored — see fixtures/.prepared). */
export function preparedNpmDir(system: SystemId): string {
  return join(paths.fixturesDir, '.prepared', `${system}-app`);
}

/**
 * Rewrites (cssEntry set) or removes (cssEntry absent) the __CSS_ENTRY__
 * placeholder import line in destDir/src/main.tsx. No-op if the file has no
 * such line — 'source'-mode templates hardcode their own CSS import and never
 * contain the placeholder. Exported so npm-fixture placeholder handling can
 * be unit-tested without a real npm install.
 */
export function applyCssEntryPlaceholder(destDir: string, cssEntry: string | undefined): void {
  applyImportLinePlaceholder(destDir, CSS_ENTRY_PLACEHOLDER, cssEntry);
}

/**
 * Source-mode counterpart to applyCssEntryPlaceholder: rewrites or removes
 * source-app's `import '__FOUNDATIONS_CSS_ENTRY__';` line. Source mode never
 * imports a real npm specifier for the foundations stylesheet — it imports
 * `${foundationsPkg}/index.css`, a bare specifier that vite.config.ts/
 * tsconfig.json alias straight at __SYSTEM_ROOT__/__FOUNDATIONS_CSS__ — so
 * when there is no single file to alias the import is dropped entirely rather
 * than rewritten, leaving those aliases pointing at nothing but never resolved.
 */
export function applyFoundationsCssPlaceholder(destDir: string, cfg: SystemConfig): void {
  const aliasable = aliasableFoundationsCss(cfg);
  if (!aliasable && Array.isArray(cfg.foundationsCss) && cfg.foundationsCss.length > 1) {
    // Loud, because the agent is about to see an unstyled app and nothing
    // else in the run would say why.
    console.warn(
      `[fixture] foundationsCss names ${cfg.foundationsCss.length} files and the source template can alias only one, ` +
        `so this workspace provisions without the design system's stylesheet. Name an aggregate CSS entry point here, ` +
        `or point fixtureTemplate at a template that imports the files itself.`,
    );
  }
  applyImportLinePlaceholder(destDir, FOUNDATIONS_CSS_ENTRY_PLACEHOLDER, aliasable ? `${cfg.foundationsPkg}/index.css` : undefined);
}

/**
 * Copies the generic npm-consume template into this system's prepared dir and
 * bakes in the cssEntry placeholder — everything prepareTemplate's 'npm'
 * branch does short of the two npm installs. Exported so the copy +
 * placeholder step can be unit-tested without a real network install.
 */
export function stageNpmTemplate(system: SystemId, cfg: SystemConfig): string {
  const dest = preparedNpmDir(system);
  copyTemplate(npmTemplateSourceDir(cfg), dest);
  applyCssEntryPlaceholder(dest, cfg.cssEntry);
  return dest;
}

async function prepareNpmTemplate(system: SystemId, cfg: SystemConfig): Promise<void> {
  const dest = preparedNpmDir(system);
  if (existsSync(join(dest, 'node_modules'))) return;

  const spec = cfg.packageSpec ?? cfg.componentsPkg;
  if (!spec) {
    throw new Error(`"${system}": consume "npm" requires "packageSpec" (or "componentsPkg") to be set`);
  }

  stageNpmTemplate(system, cfg);

  // Two installs: the template's own deps (react, vite, ...), then the DS
  // package itself — kept separate so a bad packageSpec fails clearly on the
  // second step rather than aborting the whole dependency set. fixturePins
  // ride along with the package spec so npm resolves them as one tree (a
  // pinned react@18 must downgrade the template's react@19 in the same pass,
  // or the peer solver rejects the install).
  await execFileAsync('npm', npmInstallArgs(), { cwd: dest, maxBuffer: 50 * 1024 * 1024 });
  await execFileAsync('npm', npmInstallArgs([...(cfg.fixturePins ?? []), spec]), { cwd: dest, maxBuffer: 50 * 1024 * 1024 });
}

/** npm install in the system's fixture template dir, once. No-op if node_modules already exists. */
export async function prepareTemplate(system: SystemId, cfg: SystemConfig): Promise<void> {
  if (cfg.consume === 'npm') {
    await prepareNpmTemplate(system, cfg);
    return;
  }

  const dir = templateDir(system, cfg);
  if (existsSync(join(dir, 'node_modules'))) return;

  await execFileAsync('npm', npmInstallArgs(), { cwd: dir, maxBuffer: 50 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// Custom-element JSX types
// ---------------------------------------------------------------------------
//
// TypeScript rejects an undeclared dashed tag ("Property 'ds-button' does not
// exist on type 'JSX.IntrinsicElements'"), so a web-component fixture needs a
// declaration for every element the system ships. It is generated from the
// extracted catalog rather than shipped in the template, because the element
// names ARE the system's API and no static template can know them.
//
// This is not a ground-truth leak. A source-consuming React fixture already
// aliases the whole component tree into the workspace, where the agent can
// read every export and prop; this file gives a web-component system's agent
// the same access and no more. Task prompts still never name a component.
//
// Prop TYPES are emitted from the catalog wherever they can be trusted
// verbatim, and fall back to `unknown` where they cannot. An earlier version
// typed every prop `unknown` on the theory that values were apiFidelity's job.
// That was wrong, and the first real run proved it: a model wrote
// variant="danger" on an element whose variant is
// "destructive" | "muted" | "negative" | "primary" | "secondary" | "tertiary",
// and scored 100 on both apiFidelity and compile. apiFidelity checks prop
// NAMES, never values, so with `unknown` here nothing in the harness checked
// them at all — an invented value was strictly invisible.
//
// "Trusted verbatim" is deliberately narrow (see isSelfContainedType): string
// and numeric literal unions plus the primitive keywords, i.e. types that
// depend on nothing outside this file. A type naming another symbol
// (`ButtonConfig`, `EventEmitter<T>`, an inline object or function shape)
// would not resolve here, so it degrades to `unknown`. Measured on a real
// 110-element system, the large majority of its 317 props emit a real type and
// the rest degrade.

/** Doc comment lines for one element, or '' when it has no description. */
function elementDocComment(description: string | undefined, indent: string): string {
  const text = (description ?? '').trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */\n`;
}

// One union member that resolves without reference to anything else: a string
// or numeric literal, or a primitive/top/bottom keyword.
const SELF_CONTAINED_ATOM =
  '(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|-?\\d+(?:\\.\\d+)?' +
  '|string|number|boolean|bigint|symbol|null|undefined|true|false|any|unknown|never|void)';
const SELF_CONTAINED_TYPE_RE = new RegExp(`^\\s*${SELF_CONTAINED_ATOM}(?:\\s*\\|\\s*${SELF_CONTAINED_ATOM})*\\s*$`);

/**
 * True when a catalog type string can be pasted into the generated .d.ts as
 * written. Conservative on purpose: a type that references any other symbol is
 * rejected even though it might resolve, because an unresolvable name here
 * silently makes the prop accept anything (the fixture compiles with
 * skipLibCheck, so tsc reports nothing for the .d.ts itself) — which is the
 * exact blindness emitting real types is meant to remove.
 */
export function isSelfContainedType(type: string | undefined): boolean {
  if (!type) return false;
  const trimmed = type.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'unknown') return false;
  return SELF_CONTAINED_TYPE_RE.test(trimmed);
}

// Attributes every element accepts on top of its own props. `class` and `for`
// are the HTML spellings of className/htmlFor: React 19 passes both straight
// through on a custom element (unlike a native one, where it tells you to use
// className), and a web-component system's docs are HTML, so its examples use
// them. This list must stay in step with the custom-element branch of
// isAttrAllowed in src/grade/mechanical/api-fidelity.ts, or the grader and the
// compiler disagree about the same attribute.
const UNIVERSAL_ELEMENT_ATTRS: Record<string, string> = { class: 'string', for: 'string' };

/**
 * A .d.ts declaring every catalog element as a JSX intrinsic. Elements are
 * identified by a dash in the name, which is the custom-element spec's own
 * rule and therefore excludes the PascalCase class-name spellings the catalog
 * also carries for framework wrappers.
 */
export function renderCustomElementTypes(catalog: SystemCatalog): string {
  const described = new Map<string, string>();
  // Documented props carry the types; allPropsByExport carries the full
  // gradeable name list, including attribute aliases that have no catalog
  // entry of their own. An alias inherits the type of the prop it spells
  // differently — `control-type` accepts exactly what `controlType` accepts.
  const typeByTagProp = new Map<string, string>();
  for (const comp of catalog.components) {
    for (const exp of comp.exports) {
      described.set(exp.displayName, exp.description);
      for (const prop of exp.props) {
        if (!isSelfContainedType(prop.type)) continue;
        typeByTagProp.set(`${exp.displayName}\u0000${prop.name}`, prop.type.trim());
        const camel = prop.name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
        const kebab = prop.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
        for (const alias of [camel, kebab]) {
          const key = `${exp.displayName}\u0000${alias}`;
          if (!typeByTagProp.has(key)) typeByTagProp.set(key, prop.type.trim());
        }
      }
    }
  }

  const tags = catalog.allExports.filter((name) => name.includes('-')).sort();

  const entries = tags.map((tag) => {
    const doc = elementDocComment(described.get(tag), '      ');
    // Deduped, because a duplicate key in a type literal is a redeclaration,
    // and the catalog's own prop list plus the universal attributes above can
    // legitimately name the same attribute twice.
    const props = new Map<string, string>(Object.entries(UNIVERSAL_ELEMENT_ATTRS));
    for (const prop of catalog.allPropsByExport[tag] ?? []) {
      props.set(prop, typeByTagProp.get(`${tag}\u0000${prop}`) ?? 'unknown');
    }
    const propLines = [...props]
      .map(([prop, type]) => `        ${JSON.stringify(prop)}?: ${type};`)
      .join('\n');
    return `${doc}      ${JSON.stringify(tag)}: ElementAttributes<{\n${propLines}\n      }>;`;
  });

  return [
    '// GENERATED at workspace provision time from the extracted catalog.',
    '// Every element this design system ships, with the attributes it accepts.',
    '// Do not edit: it is the system\'s API surface, not part of the task.',
    "import type { DetailedHTMLProps, HTMLAttributes } from 'react';",
    '',
    '// Everything React allows on any host element — id, style, className,',
    '// aria-*, data-*, event handlers, and, via DetailedHTMLProps, `key` and',
    '// `ref` — with the keys the element declares itself removed first.',
    '//',
    '// The Omit is load-bearing twice over. An intersection NARROWS a shared',
    '// key rather than replacing it, so an element whose own `hidden` is a',
    '// string union would meet React\'s boolean `hidden` and collapse to',
    '// `never`, failing compile on every value including the documented ones.',
    '// And HTMLAttributes alone carries neither `key` nor `ref` (native',
    '// elements get those from DetailedHTMLProps), so without this an ordinary',
    '// `{items.map((i) => <ds-row key={i.id} />)}` would not compile.',
    'type ElementAttributes<P> = Omit<DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>, keyof P> & P;',
    '',
    "declare module 'react' {",
    '  namespace JSX {',
    '    interface IntrinsicElements {',
    entries.join('\n'),
    '    }',
    '  }',
    '}',
    '',
    'export {};',
    '',
  ].join('\n');
}

/**
 * Writes the generated element declarations into a provisioned workspace.
 * No-op unless the system is custom-element-shaped.
 */
export function writeCustomElementTypes(cfg: SystemConfig, destDir: string, catalog: SystemCatalog): void {
  if (cfg.componentModel !== 'custom-elements') return;
  mkdirSync(join(destDir, 'src'), { recursive: true });
  writeFileSync(join(destDir, 'src', 'system-elements.d.ts'), renderCustomElementTypes(catalog), 'utf8');
}

export interface ProvisionOptions {
  system: SystemId;
  systemCfg: SystemConfig;
  context: ContextLevel;
  destDir: string;
  /**
   * Extracted ground truth, used to generate JSX types for a custom-element
   * system and ignored for other component models. Required rather than
   * optional: runBench loads every involved system's assets up front and
   * throws "ground truth missing" there, so a provision with no catalog is
   * unreachable, and an optional field would only invite a silent skip.
   */
  catalog: SystemCatalog;
}

/** Copies a fixture template dir into destDir, excluding any node_modules. Exported for tests. */
export function copyTemplate(templateDirPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  cpSync(templateDirPath, destDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('node_modules'),
  });
}

/**
 * Fills the generic source template's placeholders from the system's own
 * config. Exported so the source-mode copy + substitution step can be
 * unit-tested without a real npm install, mirroring stageNpmTemplate's role
 * for npm mode.
 */
export function substitutePlaceholders(destDir: string, cfg: SystemConfig): void {
  for (const rel of SUBSTITUTED_FILES) {
    const filePath = join(destDir, rel);
    if (!existsSync(filePath)) continue;
    const next = readFileSync(filePath, 'utf8')
      .split(SYSTEM_ROOT_PLACEHOLDER).join(cfg.root)
      .split(COMPONENTS_PKG_PLACEHOLDER).join(cfg.componentsPkg)
      .split(FOUNDATIONS_PKG_PLACEHOLDER).join(cfg.foundationsPkg)
      .split(COMPONENTS_SRC_PLACEHOLDER).join(cfg.componentsSrc)
      .split(FOUNDATIONS_CSS_PLACEHOLDER).join(aliasableFoundationsCss(cfg) ?? FOUNDATIONS_CSS_FALLBACK);
    writeFileSync(filePath, next, 'utf8');
  }
}

function linkNodeModules(templateDirPath: string, destDir: string): void {
  const dest = join(destDir, 'node_modules');
  removeIfExists(dest);
  symlinkSync(join(templateDirPath, 'node_modules'), dest, 'dir');
}

function removeIfExists(p: string): void {
  try {
    lstatSync(p);
  } catch {
    return;
  }
  rmSync(p, { recursive: true, force: true });
}

/** Copies systemCfg.agentContext.agentsMd files into destDir root. First file becomes
 * both AGENTS.md and CLAUDE.md; any further files keep their own basename. */
function injectAgentsMd(systemCfg: SystemConfig, destDir: string): void {
  systemCfg.agentContext.agentsMd.forEach((relPath, i) => {
    const content = readFileSync(join(systemCfg.root, relPath));
    if (i === 0) {
      writeFileSync(join(destDir, 'AGENTS.md'), content);
      writeFileSync(join(destDir, 'CLAUDE.md'), content);
    } else {
      writeFileSync(join(destDir, basename(relPath)), content);
    }
  });
}

/**
 * Copies each configured skillDir into destDir/.claude/skills/, where an
 * agent can actually discover it — that is, as `.claude/skills/<name>/SKILL.md`.
 *
 * A configured path can reasonably be either shape, and the difference is one
 * directory level, which is the whole ballgame: a skill nested one level too
 * deep is not found, and the run silently measures an unskilled agent at the
 * context level whose entire purpose is measuring a skilled one. One system
 * declares `.agents/skills`, a directory OF eighteen skill bundles, and every
 * one of them landed at `.claude/skills/skills/<name>/SKILL.md` and was
 * invisible.
 *
 * So detect rather than assume: a directory holding its own SKILL.md is one
 * bundle and keeps its name; otherwise it is a container and each child bundle
 * is copied under its own name. A container whose children are not bundles
 * either is copied verbatim rather than silently dropped — better to hand the
 * agent the files and let the context level be judged on them.
 */
function injectSkillDirs(systemCfg: SystemConfig, destDir: string): void {
  const skillsRoot = join(destDir, '.claude', 'skills');
  const copyBundle = (src: string, name: string) => {
    const dest = join(skillsRoot, name);
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
  };

  for (const dir of systemCfg.agentContext.skillDirs ?? []) {
    const src = join(systemCfg.root, dir);
    if (existsSync(join(src, 'SKILL.md'))) {
      copyBundle(src, basename(dir)); // a single skill bundle
      continue;
    }
    let children: string[] = [];
    try {
      children = readdirSync(src, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(src, e.name, 'SKILL.md')))
        .map((e) => e.name);
    } catch {
      // unreadable — fall through to the verbatim copy below
    }
    if (children.length > 0) {
      for (const child of children) copyBundle(join(src, child), child);
      continue;
    }
    copyBundle(src, basename(dir));
  }
}

// A local glob matcher rather than node:fs globSync: that API exists on the
// Node 22 this project runs, but @types/node is pinned to ^20 and does not
// declare it, and bumping a dependency to reach one call is a worse trade than
// twenty lines. Supports the two wildcards a docs glob needs — `*` within a
// path segment, `**` spanning segments.
const GLOB_WALK_MAX_FILES = 20_000;

/** Anchored regex for a posix-style glob, matched against root-relative paths. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled && pattern[i + 2] === '/') {
        out += '(?:[^/]+/)*'; // `**/` — zero or more directories
        i += 2;
      } else if (doubled) {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*'; // `*` — within one segment
      }
      continue;
    }
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** The literal directory prefix of a glob, i.e. everything before the first wildcard segment. */
function globBaseDir(pattern: string): string {
  const segments = pattern.split('/');
  const literal: string[] = [];
  for (const seg of segments) {
    if (seg.includes('*')) break;
    literal.push(seg);
  }
  // Drop a trailing filename-looking segment only when it is the whole pattern.
  return literal.length === segments.length ? literal.slice(0, -1).join('/') : literal.join('/');
}

/**
 * Root-relative paths of every file under `root` matching `pattern`. Walks
 * only the glob's literal prefix rather than the whole checkout, skipping
 * vendor/build and dot directories. Best-effort and capped: a docs glob must
 * never hang or explode a provision step.
 */
function globFiles(root: string, pattern: string): string[] {
  const re = globToRegExp(pattern);
  const out: string[] = [];
  const walk = (relDir: string): void => {
    if (out.length >= GLOB_WALK_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= GLOB_WALK_MAX_FILES) return;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile() && re.test(rel)) out.push(rel);
    }
  };
  walk(globBaseDir(pattern));
  return out.sort();
}

/**
 * Copies each configured extraDocs entry into destDir/docs/, then points
 * CLAUDE.md at it. Two shapes, because real doc sets need both:
 *
 *   - A literal file or directory path lands at `docs/<basename>`, flattened.
 *     This is the original behavior and existing configs depend on it.
 *   - A glob (any entry containing `*`) copies every match to
 *     `docs/<path relative to root>`, preserving structure. Flattening is not
 *     an option there: a hundred files all named readme.md would overwrite
 *     each other down to one, and an index that links to its siblings by
 *     relative path only resolves if the tree is kept intact.
 *
 * Globs exist because the interesting documentation is often scattered
 * through the source tree rather than gathered in a docs directory. On one
 * production system the per-component API tables live at
 * src/components/<group>/<tag>/readme.md — 487 KB across 110 files, inside a
 * 26 MB tree that is mostly image assets. Naming the directory would copy all
 * 26 MB and hand the agent the .tsx implementation an npm consumer never sees;
 * naming 110 literal paths is not a config anyone maintains.
 *
 * A pattern matching nothing is warned about rather than passed over: it is
 * the same silent shortfall a missing literal path throws on, and the whole
 * point of a guided context level is that the agent got what the config
 * promised it.
 */
function injectExtraDocs(systemCfg: SystemConfig, destDir: string): void {
  const docsDir = join(destDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  for (const docPath of systemCfg.agentContext.extraDocs ?? []) {
    if (docPath.includes('*')) {
      const matches = globFiles(systemCfg.root, docPath);
      if (matches.length === 0) {
        console.warn(
          `[fixture] extraDocs pattern '${docPath}' matched no files under ${systemCfg.root} — nothing injected for it`,
        );
      }
      for (const rel of matches) {
        const dest = join(docsDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(systemCfg.root, rel), dest, { recursive: true });
      }
      continue;
    }
    const src = join(systemCfg.root, docPath);
    const dest = join(docsDir, basename(docPath));
    cpSync(src, dest, { recursive: true });
  }

  const claudeMdPath = join(destDir, 'CLAUDE.md');
  const note =
    '\n## Design system reference docs\n\n' +
    'Component API reference and token list live in docs/ — consult them before writing UI.\n';
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : '';
  writeFileSync(claudeMdPath, `${existing}\n${note}`, 'utf8');
}

/** injectContext, exported for tests: context injection is otherwise only reachable through a full provision, which needs a prepared template. */
export function injectContextForTest(systemCfg: SystemConfig, context: ContextLevel, destDir: string): void {
  injectContext(systemCfg, context, destDir);
}

function injectContext(systemCfg: SystemConfig, context: ContextLevel, destDir: string): void {
  if (context === 'bare') return;

  if (context === 'mcp') {
    throw new Error('mcp context is reserved for the next phase');
  }

  // 'agents-md' and 'skill' both start from the agents-md files.
  injectAgentsMd(systemCfg, destDir);

  if (context === 'skill') {
    // Config-driven, not identity-driven: a system supplies whichever of
    // these its agentContext declares (skill bundles, extra reference docs,
    // or both) — nothing here is keyed off a hardcoded system id.
    if (systemCfg.agentContext.skillDirs?.length) injectSkillDirs(systemCfg, destDir);
    if (systemCfg.agentContext.extraDocs?.length) injectExtraDocs(systemCfg, destDir);
  }
}

async function commitBaseline(destDir: string): Promise<void> {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: destDir, maxBuffer: 10 * 1024 * 1024 });
  await git(['init']);
  await git(['add', '-A']);
  // -c commit.gpgsign=false: this is a disposable, local-only scratch repo used
  // purely as a diff mechanism for grading agent edits — it is never pushed or
  // inspected as a real commit history, and honoring the operator's global
  // commit.gpgsign would make unattended provisioning hang on a GPG prompt.
  await execFileAsync(
    'git',
    [
      '-c', 'user.name=open-design-system-bench',
      '-c', 'user.email=bench@local',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', 'baseline',
    ],
    { cwd: destDir, maxBuffer: 10 * 1024 * 1024 },
  );
}

export async function provisionWorkspace(opts: ProvisionOptions): Promise<void> {
  const { system, systemCfg, context, destDir, catalog } = opts;
  const srcTemplateDir = templateDir(system, systemCfg);

  if (!existsSync(join(srcTemplateDir, 'node_modules'))) {
    throw new Error(
      `Template for "${system}" is not prepared (${srcTemplateDir}/node_modules missing). Call prepareTemplate("${system}", cfg) first.`,
    );
  }

  copyTemplate(srcTemplateDir, destDir);
  substitutePlaceholders(destDir, systemCfg);
  applyFoundationsCssPlaceholder(destDir, systemCfg);
  applyCssEntryPlaceholder(destDir, systemCfg.cssEntry);
  // Before commitBaseline, so the generated declarations are part of the
  // baseline tree and collect.ts does not read them as agent-authored.
  writeCustomElementTypes(systemCfg, destDir, catalog);
  linkNodeModules(srcTemplateDir, destDir);
  injectContext(systemCfg, context, destDir);
  await commitBaseline(destDir);
}

/** Restore the node_modules symlink if pruneWorkspace already removed it. Returns a cleanup. */
export function ensureWorkspaceNodeModules(workspaceDir: string, system: SystemId, cfg: SystemConfig): () => void {
  const dest = join(workspaceDir, 'node_modules');
  if (existsSync(dest)) return () => {};
  const target = join(templateDir(system, cfg), 'node_modules');
  if (!existsSync(target)) {
    throw new Error(`fixture node_modules missing for ${system} — run prepareTemplate first`);
  }
  symlinkSync(target, dest, 'dir');
  return () => {
    try {
      unlinkSync(dest);
    } catch {
      /* already gone */
    }
  };
}

/** Removes the node_modules symlink from a provisioned workspace, keeping everything else. */
export async function pruneWorkspace(destDir: string): Promise<void> {
  const nodeModules = join(destDir, 'node_modules');
  try {
    const stat = lstatSync(nodeModules);
    if (stat.isSymbolicLink()) {
      unlinkSync(nodeModules);
    }
  } catch {
    // Already absent — nothing to prune.
  }
}
