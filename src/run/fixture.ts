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
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { PKG_ROOT, paths } from '../config.ts';
import type { ContextLevel, SystemConfig, SystemId } from '../types.ts';

const execFileAsync = promisify(execFile);

const NPM_CACHE_DIR = join(PKG_ROOT, '.npm-cache');
const SYSTEM_ROOT_PLACEHOLDER = '__SYSTEM_ROOT__';
const COMPONENTS_PKG_PLACEHOLDER = '__COMPONENTS_PKG__';
const FOUNDATIONS_PKG_PLACEHOLDER = '__FOUNDATIONS_PKG__';
const SUBSTITUTED_FILES = ['vite.config.ts', 'tsconfig.json', 'index.html', 'src/App.tsx', 'src/main.tsx'];
const CSS_ENTRY_PLACEHOLDER = '__CSS_ENTRY__';
const CSS_ENTRY_PLACEHOLDER_LINE = `import '${CSS_ENTRY_PLACEHOLDER}';\n`;

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
 * Step 3 is what makes source mode work out of the box: the generic template
 * carries __SYSTEM_ROOT__ / __COMPONENTS_PKG__ / __FOUNDATIONS_PKG__
 * placeholders that provisionWorkspace fills in from the system's own config.
 */
export function templateDir(system: SystemId, cfg: SystemConfig): string {
  if (cfg.consume === 'npm') return preparedNpmDir(system);
  if (cfg.fixtureTemplate) return resolve(PKG_ROOT, cfg.fixtureTemplate);
  const perSystem = join(paths.fixturesDir, `${system}-app`);
  return existsSync(perSystem) ? perSystem : join(paths.fixturesDir, 'source-app');
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
  const mainPath = join(destDir, 'src', 'main.tsx');
  if (!existsSync(mainPath)) return;
  const content = readFileSync(mainPath, 'utf8');
  if (!content.includes(CSS_ENTRY_PLACEHOLDER_LINE)) return;
  const next = cssEntry
    ? content.replace(CSS_ENTRY_PLACEHOLDER_LINE, `import '${cssEntry}';\n`)
    : content.replace(CSS_ENTRY_PLACEHOLDER_LINE, '');
  writeFileSync(mainPath, next, 'utf8');
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

export interface ProvisionOptions {
  system: SystemId;
  systemCfg: SystemConfig;
  context: ContextLevel;
  destDir: string;
}

function copyTemplate(templateDirPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  cpSync(templateDirPath, destDir, {
    recursive: true,
    filter: (src) => !src.split(sep).includes('node_modules'),
  });
}

/** Fills the generic source template's placeholders from the system's own config. */
function substitutePlaceholders(destDir: string, cfg: SystemConfig): void {
  for (const rel of SUBSTITUTED_FILES) {
    const filePath = join(destDir, rel);
    if (!existsSync(filePath)) continue;
    const next = readFileSync(filePath, 'utf8')
      .split(SYSTEM_ROOT_PLACEHOLDER).join(cfg.root)
      .split(COMPONENTS_PKG_PLACEHOLDER).join(cfg.componentsPkg)
      .split(FOUNDATIONS_PKG_PLACEHOLDER).join(cfg.foundationsPkg);
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

/** Copies each configured skillDir into destDir/.claude/skills/<dirname>/. */
function injectSkillDirs(systemCfg: SystemConfig, destDir: string): void {
  for (const dir of systemCfg.agentContext.skillDirs ?? []) {
    const src = join(systemCfg.root, dir);
    const dest = join(destDir, '.claude', 'skills', basename(dir));
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
}

/** Copies each configured extraDocs file/dir into destDir/docs/, then points CLAUDE.md at it. */
function injectExtraDocs(systemCfg: SystemConfig, destDir: string): void {
  const docsDir = join(destDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  for (const docPath of systemCfg.agentContext.extraDocs ?? []) {
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
  const { system, systemCfg, context, destDir } = opts;
  const srcTemplateDir = templateDir(system, systemCfg);

  if (!existsSync(join(srcTemplateDir, 'node_modules'))) {
    throw new Error(
      `Template for "${system}" is not prepared (${srcTemplateDir}/node_modules missing). Call prepareTemplate("${system}", cfg) first.`,
    );
  }

  copyTemplate(srcTemplateDir, destDir);
  substitutePlaceholders(destDir, systemCfg);
  applyCssEntryPlaceholder(destDir, systemCfg.cssEntry);
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
