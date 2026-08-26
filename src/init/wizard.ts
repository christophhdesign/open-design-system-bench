// The `init` wizard: interrogates (interactively, or via pre-supplied answers)
// enough about a design system to write a SystemConfig entry into
// systems.config.json, scaffolds a starter task suite, and reports
// doctor-grade ok/warn checks so the operator knows what to fix before their
// first `extract`/`run`. Exported as a plain function (runInit) — the CLI
// command wiring (flag parsing, stdin/stdout plumbing for interactive mode)
// lives in src/cli.ts, owned separately; this module has no dependency on it.

import { createInterface } from 'node:readline/promises';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { paths } from '../config.ts';
import type { SystemConfig, SystemId, SystemsConfig } from '../types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitAnswers {
  systemId: SystemId;
  /** Cosmetic only — echoed in the printed summary, not persisted to systems.config.json (SystemConfig has no display-name field). */
  displayName?: string;
  consume: 'npm' | 'source';
  /** npm mode: the npm install spec, e.g. "@acme/ui" or "@acme/ui@^2.0.0". */
  packageSpec?: string;
  /** source mode: absolute path to the design system's repo checkout. npm mode: optional base dir for agentsMd docs; defaults to cwd. */
  root?: string;
  /** source mode: path to the components source dir, relative to root. */
  componentsSrc?: string;
  /** The npm package name components/tokens are imported from. Derived from packageSpec (npm mode) or systemId (source mode) when omitted. */
  componentsPkg?: string;
  /** Defaults to componentsPkg when omitted. */
  foundationsPkg?: string;
  /** Path (relative to root) to a CSS-custom-property token file. Optional in either mode. */
  foundationsCss?: string;
  /** Import specifier for the system's stylesheet in npm mode's fixture (e.g. "@acme/ui/styles.css"). */
  cssEntry?: string;
  /** Files copied at context level "agents-md", relative to root. Default ["AGENTS.md", "README.md"]. Literal paths — see the doctor check for why these aren't real globs. */
  agentsMd?: string[];
  /** Skill bundle dirs injected at context level "skill", relative to root. */
  skillDirs?: string[];
  catalogStrategy?: 'docgen' | 'catalog-json' | 'none';
  /** Required (semantically) when catalogStrategy is "catalog-json"; path relative to root. */
  catalogFile?: string;
}

export interface RunInitOptions {
  nonInteractive?: boolean;
  answers?: Partial<InitAnswers>;
  cwd?: string;
}

export interface RunInitResult {
  configPath: string;
  summary: string;
}

interface SystemsConfigFile {
  systems: SystemsConfig;
  dataDir?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS_MD = ['AGENTS.md', 'README.md'];
// A small, representative slice of the ten domain-neutral starter tasks
// already shipped in tasks/ — confirmation pattern, transient feedback,
// toggle state. Scaffolded verbatim (never overwritten) so a fresh init has
// something runnable immediately; the full ten stay the package's own
// reference suite.
const STARTER_TASK_IDS = ['confirm-account-deletion', 'success-feedback', 'settings-toggle-section'];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runInit(opts: RunInitOptions = {}): Promise<RunInitResult> {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const nonInteractive = opts.nonInteractive ?? false;
  const configPath = join(cwd, 'systems.config.json');

  const answers = nonInteractive ? requireAnswers(opts.answers, cwd) : await gatherInteractive(opts.answers, cwd);
  if (!answers) {
    return { configPath, summary: 'aborted: no changes made' };
  }

  hardValidate(answers);

  const existing = loadExistingConfigFile(configPath);
  const replacing = !!existing.systems[answers.systemId];
  if (replacing && !nonInteractive) {
    const proceed = await confirmReplace(answers.systemId);
    if (!proceed) {
      return { configPath, summary: `aborted: kept the existing "${answers.systemId}" entry unchanged in ${configPath}` };
    }
  }

  const systemConfig = buildSystemConfig(answers, cwd);
  existing.systems[answers.systemId] = systemConfig;
  writeConfigFile(configPath, existing);

  const checks = doctorGradeChecks(answers, systemConfig);
  const tasksResult = scaffoldStarterTasks(cwd);

  const summary = buildSummary({
    configPath,
    systemId: answers.systemId,
    displayName: answers.displayName,
    replaced: replacing,
    checks,
    tasksResult,
  });

  return { configPath, summary };
}

// ---------------------------------------------------------------------------
// Interactive prompting
// ---------------------------------------------------------------------------

async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
  def: string | undefined,
): Promise<string> {
  const suffix = def ? ` [${def}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || def || '';
}

async function gatherInteractive(preset: Partial<InitAnswers> | undefined, cwd: string): Promise<InitAnswers | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const systemId = await ask(rl, 'System id (key in systems.config.json)', preset?.systemId ?? 'my-system');
    const displayName = await ask(rl, 'Display name', preset?.displayName ?? systemId);
    const consumeRaw = await ask(rl, 'Consume mode (npm|source)', preset?.consume ?? 'npm');
    const consume: 'npm' | 'source' = consumeRaw === 'source' ? 'source' : 'npm';

    let packageSpec: string | undefined;
    let root: string | undefined;
    let componentsSrc: string | undefined;
    if (consume === 'npm') {
      packageSpec = await ask(rl, 'npm package spec to install (e.g. @scope/ui or @scope/ui@^2.0.0)', preset?.packageSpec ?? '');
      root = await ask(rl, 'Repo root for docs/context files (optional)', preset?.root ?? cwd);
    } else {
      root = await ask(rl, 'Design system repo root (absolute path)', preset?.root ?? '');
      componentsSrc = await ask(rl, 'Components source dir (relative to root)', preset?.componentsSrc ?? 'src/components');
    }

    const cssEntry = await ask(rl, 'CSS entry import specifier (optional, blank to skip)', preset?.cssEntry ?? '');
    const agentsMdRaw = await ask(
      rl,
      'Docs files for the "agents-md" context level (comma-separated)',
      (preset?.agentsMd?.length ? preset.agentsMd : DEFAULT_AGENTS_MD).join(','),
    );
    const skillDirsRaw = await ask(rl, 'Skill dirs (comma-separated, optional)', (preset?.skillDirs ?? []).join(','));
    const catalogStrategyRaw = await ask(
      rl,
      'Catalog strategy (docgen|catalog-json|none)',
      preset?.catalogStrategy ?? (consume === 'npm' ? 'none' : 'docgen'),
    );
    const catalogStrategy = normalizeCatalogStrategy(catalogStrategyRaw);

    let catalogFile: string | undefined;
    if (catalogStrategy === 'catalog-json') {
      catalogFile = await ask(rl, 'Path to the pre-built catalog JSON (relative to root)', preset?.catalogFile ?? '');
    }

    return {
      systemId,
      displayName,
      consume,
      packageSpec: packageSpec || undefined,
      root: root || undefined,
      componentsSrc,
      cssEntry: cssEntry || undefined,
      agentsMd: splitList(agentsMdRaw),
      skillDirs: splitList(skillDirsRaw),
      catalogStrategy,
      catalogFile: catalogFile || undefined,
    };
  } finally {
    rl.close();
  }
}

async function confirmReplace(systemId: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await ask(rl, `System "${systemId}" already exists in systems.config.json. Replace it? (y/N)`, 'N');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeCatalogStrategy(raw: string): 'docgen' | 'catalog-json' | 'none' {
  return raw === 'docgen' || raw === 'catalog-json' || raw === 'none' ? raw : 'none';
}

// ---------------------------------------------------------------------------
// Non-interactive answers
// ---------------------------------------------------------------------------

function requireAnswers(preset: Partial<InitAnswers> | undefined, cwd: string): InitAnswers {
  if (!preset) {
    throw new Error('init: non-interactive mode requires "answers" (systemId, consume, ...)');
  }
  if (!preset.systemId || !preset.systemId.trim()) {
    throw new Error('init: answers.systemId is required in non-interactive mode');
  }
  if (preset.consume !== 'npm' && preset.consume !== 'source') {
    throw new Error('init: answers.consume must be "npm" or "source" in non-interactive mode');
  }

  return {
    systemId: preset.systemId,
    displayName: preset.displayName,
    consume: preset.consume,
    packageSpec: preset.packageSpec,
    root: preset.root ?? (preset.consume === 'npm' ? cwd : undefined),
    componentsSrc: preset.componentsSrc,
    componentsPkg: preset.componentsPkg,
    foundationsPkg: preset.foundationsPkg,
    foundationsCss: preset.foundationsCss,
    cssEntry: preset.cssEntry,
    agentsMd: preset.agentsMd?.length ? preset.agentsMd : DEFAULT_AGENTS_MD,
    skillDirs: preset.skillDirs,
    catalogStrategy: preset.catalogStrategy ?? (preset.consume === 'npm' ? 'none' : 'docgen'),
    catalogFile: preset.catalogFile,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Hard failures only — the two prerequisites the deliverable calls out. Everything else is a soft doctor-grade warning (see doctorGradeChecks). */
function hardValidate(answers: InitAnswers): void {
  if (!answers.systemId || !answers.systemId.trim()) {
    throw new Error('init: "systemId" is required');
  }
  if (answers.consume === 'source') {
    if (!answers.root || !existsSync(answers.root)) {
      throw new Error(`init: consume "source" requires an existing "root" directory (got ${answers.root ?? '(none)'})`);
    }
  } else if (answers.consume === 'npm') {
    if (!answers.packageSpec || !answers.packageSpec.trim()) {
      throw new Error('init: consume "npm" requires a non-empty "packageSpec"');
    }
  } else {
    throw new Error(`init: "consume" must be "npm" or "source" (got ${String(answers.consume)})`);
  }
}

// ---------------------------------------------------------------------------
// SystemConfig construction
// ---------------------------------------------------------------------------

function slug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/** Strips a trailing "@version"/"@tag" from an npm spec: "@acme/ui@^2.0.0" -> "@acme/ui", "left-pad@1" -> "left-pad". */
function stripVersion(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

function deriveComponentsPkg(answers: InitAnswers): string {
  if (answers.consume === 'npm' && answers.packageSpec) return stripVersion(answers.packageSpec);
  return `@${slug(answers.systemId)}/components`;
}

function buildSystemConfig(answers: InitAnswers, cwd: string): SystemConfig {
  const root = answers.consume === 'npm' ? resolve(answers.root ?? cwd) : resolve(answers.root!);
  const componentsPkg = answers.componentsPkg ?? deriveComponentsPkg(answers);
  const foundationsPkg = answers.foundationsPkg ?? componentsPkg;
  const rootEnv = `OPEN_DS_BENCH_${answers.systemId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DIR`;
  // 'none' (not chosen yet) and unset both fall back to a schema-valid
  // 'docgen' placeholder — SystemConfig.catalogStrategy has no "none" value.
  // doctorGradeChecks flags this so it isn't mistaken for a real choice.
  const catalogStrategy: 'docgen' | 'catalog-json' = answers.catalogStrategy === 'catalog-json' ? 'catalog-json' : 'docgen';

  const cfg: SystemConfig = {
    root,
    rootEnv,
    componentsSrc: answers.componentsSrc ?? 'src',
    componentsPkg,
    foundationsPkg,
    catalogStrategy,
    agentContext: {
      agentsMd: answers.agentsMd?.length ? answers.agentsMd : DEFAULT_AGENTS_MD,
    },
  };

  if (answers.foundationsCss) cfg.foundationsCss = answers.foundationsCss;
  if (catalogStrategy === 'catalog-json' && answers.catalogFile) cfg.catalogFile = answers.catalogFile;
  if (answers.skillDirs?.length) cfg.agentContext.skillDirs = answers.skillDirs;
  if (answers.consume === 'npm') {
    cfg.consume = 'npm';
    if (answers.packageSpec) cfg.packageSpec = answers.packageSpec;
  }
  if (answers.cssEntry) cfg.cssEntry = answers.cssEntry;

  return cfg;
}

// ---------------------------------------------------------------------------
// systems.config.json read/write (never clobbers other systems)
// ---------------------------------------------------------------------------

function loadExistingConfigFile(configPath: string): SystemsConfigFile {
  if (!existsSync(configPath)) return { systems: {} };
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SystemsConfigFile;
  const file: SystemsConfigFile = { systems: raw.systems ?? {} };
  if (raw.dataDir) file.dataDir = raw.dataDir;
  return file;
}

function writeConfigFile(configPath: string, file: SystemsConfigFile): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Doctor-grade checks (never fail init — ok/warn lines in the summary)
// ---------------------------------------------------------------------------

function doctorGradeChecks(answers: InitAnswers, cfg: SystemConfig): string[] {
  const lines: string[] = [];

  if (answers.consume === 'npm') {
    lines.push(
      `  ok   consume: npm — "${cfg.packageSpec ?? cfg.componentsPkg}" installs into fixtures/.prepared/${answers.systemId}-app on first run (network required once)`,
    );
  } else {
    lines.push(`  ok   consume: source — consumed from ${cfg.root} directly, no build step`);
  }

  if (answers.catalogStrategy === 'none' || !answers.catalogStrategy) {
    lines.push(
      '  warn catalogStrategy not chosen yet — persisted as "docgen" so systems.config.json stays schema-valid; ' +
        'edit catalogStrategy/catalogFile/componentsSrc once you know how to extract this system\'s catalog, then re-run extract',
    );
  }

  if (cfg.catalogStrategy === 'docgen') {
    const srcDir = join(cfg.root, cfg.componentsSrc);
    lines.push(
      existsSync(srcDir)
        ? `  ok   componentsSrc exists: ${srcDir}`
        : `  warn componentsSrc not found: ${srcDir} — edit "componentsSrc" in systems.config.json`,
    );
    const tsconfigPath = join(dirname(srcDir), 'tsconfig.json');
    lines.push(
      existsSync(tsconfigPath)
        ? `  ok   tsconfig found for docgen: ${tsconfigPath}`
        : `  warn tsconfig not found at ${tsconfigPath} — react-docgen-typescript needs one there (see catalog-docgen.ts)`,
    );
  } else if (cfg.catalogStrategy === 'catalog-json') {
    if (!cfg.catalogFile) {
      lines.push('  warn catalogStrategy is "catalog-json" but no catalogFile is set — edit systems.config.json');
    } else {
      const catalogFilePath = join(cfg.root, cfg.catalogFile);
      lines.push(
        existsSync(catalogFilePath)
          ? `  ok   catalogFile exists: ${catalogFilePath}`
          : `  warn catalogFile not found: ${catalogFilePath}`,
      );
    }
  }

  if (cfg.foundationsCss) {
    const cssPath = join(cfg.root, cfg.foundationsCss);
    lines.push(existsSync(cssPath) ? `  ok   foundationsCss exists: ${cssPath}` : `  warn foundationsCss not found: ${cssPath}`);
  } else {
    lines.push('  warn no foundationsCss configured — token/contamination checks will be skipped (fine if this system has no local CSS source)');
  }

  for (const rel of cfg.agentContext.agentsMd) {
    if (rel.includes('*')) {
      lines.push(`  warn "${rel}" looks like a glob, but agentContext.agentsMd copies literal paths only — list exact filenames`);
      continue;
    }
    const p = join(cfg.root, rel);
    lines.push(existsSync(p) ? `  ok   agents-md doc found: ${p}` : `  warn agents-md doc not found: ${p} — create it, or edit agentContext.agentsMd`);
  }

  for (const dir of cfg.agentContext.skillDirs ?? []) {
    const p = join(cfg.root, dir);
    lines.push(existsSync(p) ? `  ok   skill dir found: ${p}` : `  warn skill dir not found: ${p}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Starter task scaffolding (never overwrites)
// ---------------------------------------------------------------------------

function scaffoldStarterTasks(cwd: string): { scaffolded: boolean; reason: string } {
  const tasksDir = join(cwd, 'tasks');
  if (existsSync(tasksDir)) {
    const existingTaskFiles = readdirSync(tasksDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (existingTaskFiles.length > 0) {
      return { scaffolded: false, reason: `tasks/ already has ${existingTaskFiles.length} task file(s) — left untouched` };
    }
  }

  mkdirSync(tasksDir, { recursive: true });
  for (const id of STARTER_TASK_IDS) {
    copyFileSync(join(paths.tasksDir, `${id}.yaml`), join(tasksDir, `${id}.yaml`));
  }
  return { scaffolded: true, reason: `scaffolded ${STARTER_TASK_IDS.length} starter tasks into ${tasksDir}` };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function buildSummary(args: {
  configPath: string;
  systemId: string;
  displayName?: string;
  replaced: boolean;
  checks: string[];
  tasksResult: { scaffolded: boolean; reason: string };
}): string {
  const label = args.displayName && args.displayName !== args.systemId ? `"${args.systemId}" (${args.displayName})` : `"${args.systemId}"`;
  const lines: string[] = [];
  lines.push(`${args.replaced ? 'Replaced' : 'Added'} system ${label} in ${args.configPath}`);
  lines.push(...args.checks);
  lines.push(`  ok   ${args.tasksResult.reason}`);
  lines.push('');
  lines.push('Next steps:');
  lines.push(`  npx tsx src/cli.ts extract --config ${args.configPath} --systems ${args.systemId}`);
  lines.push(`  npx tsx src/cli.ts audit --config ${args.configPath} --systems ${args.systemId}`);
  lines.push(`  npx tsx src/cli.ts run --profile smoke --config ${args.configPath} --systems ${args.systemId}`);
  return lines.join('\n');
}
