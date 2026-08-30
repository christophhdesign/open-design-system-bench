// open-design-system-bench CLI. Exit codes follow the workspace convention (motion-perf-gate):
// 0 ok · 1 fail/regression · 2 usage/config error · 3 inconclusive.
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  PKG_ROOT,
  catalogPath,
  loadBenchConfig,
  loadSystems,
  paths,
  resolveDataDirs,
  resolveSystemsConfigPath,
  resolveTasksDir,
  tokensPath,
} from './config.ts';
import type { ContextLevel, SystemCatalog, SystemId, RunResults } from './types.ts';

const execFileP = promisify(execFile);

const USAGE = `open-design-system-bench — design-system agent benchmark

usage: tsx src/cli.ts <command> [options]

Global options (accepted by doctor, extract, validate-tasks, run, grade, judge, audit):
  --config <path>              path to a systems.config.json (default: ./systems.config.json).
                                Use this to point at a worked example config or your
                                own config without touching the checked-in default.
  --tasks-dir <path>            path to a task suite dir (default: bench.config.json's
                                defaults.tasksDir, else ./tasks)

  doctor                      verify environment (systems, catalogs, claude CLI, fixtures);
                              also HEAD-probes each configured docsUrl (5s timeout) when set
  audit [--system <id>] [--run <dir>] [--json] [--verbose] [--offline]
                              Tier-0 static audit: the seven-check enablement/catalog/
                              vocabulary/token/deprecation/docs scan plus the AI-Readiness
                              Score. No LLM ever. No network EITHER, unless a system
                              configures "docsUrl" — then hosted-surface probes (llms.txt,
                              llms-full.txt, /mcp/index.json, /registry.json) run against it
                              too, opt-in. --offline skips those probes even when docsUrl is
                              set, forcing a fully offline run. Defaults to every configured
                              system. --run <dir> adds the four behavioral sub-scores (Lift,
                              Ceiling, Engagement, Vocabulary-behavioral) computed from that
                              run's results.json; without it they report n/a. --json emits
                              the full structure instead of the human-readable report.
  init [--non-interactive --id <systemId> --consume npm|source --package <spec>
       --root <dir> --components-src <path> --css-entry <specifier> --docs-url <url>]
                              set up a system in systems.config.json (interactive by default);
                              scaffolds starter tasks when tasks/ is empty
  extract [--allow-stale] [--systems a,b]
                              extract catalogs + tokens from the configured systems' repos
  validate-tasks              lint the task suite against the extracted catalogs
  run --profile <name> [--systems a,b] [--contexts a,b] [--models a,b] [--tasks a,b]
      [--reps N] [--concurrency N] [--no-judge] [--judge-model m] [--judge-samples N]
      [--judge-provider id] [--label text]
                              run a benchmark matrix. A qualified "provider:model" entry in
                              --models (e.g. "openai:gpt-5.2", "<provider>:<model>") routes that
                              model's cells through the single-shot api-oneshot adapter for
                              that provider instead of the agentic claude-code adapter — see
                              "Providers & bring-your-own-key" in README.md for the
                              comparability caveat.
  run --resume <dir> [--retry-errored] [--concurrency N] [--no-judge] [--judge-model m]
      [--judge-samples N] [--judge-provider id] [--wait]
                              resume a paused/interrupted run (re-runs only pending cells);
                              --retry-errored also re-queues timeout/agent-error cells;
                              --wait probes every 10min for renewed usage credits instead of
                              finishing paused, giving up after 8h
  grade [--run <dir>]         re-run mechanical graders on a stored run (keeps stored judge)
  judge [--run <dir>] [--judge-model m] [--judge-samples N] [--judge-provider id]
                              re-run mechanical graders AND the judge on a stored run.
                              --judge-provider routes judging through a configured API
                              provider (bench.config.json "providers") instead of the
                              claude CLI; requires that provider's apiKeyEnv to be set.
  report [--run <dir>]        regenerate report.html from results.json
  report --stats [--run <dir>] [--system <id>] [--since <report.md>] [--out <file>]
                              compute every number an AI-readiness report needs and emit it as
                              paste-ready markdown: front matter, the generated sections, the
                              coverage list a report must address, and advisory leads. An
                              authoring agent pastes these verbatim and never does arithmetic.
                              --since <previous report> prints that report's finding ids so the
                              same defect keeps the same id across reports.
  report --validate <report.md>
                              check a report against schema/report.schema.json: generated
                              sections must byte-match a re-render, every number in the prose
                              must trace to computed data or a declared citedFigure, every
                              finding must cite real evidence, and every hard failure must be
                              addressed. Exit 1 on any violation. See docs/reports/report-authoring.md.
  compare <runDir...> [--out <file>]
                              side-by-side compare of N runs
  leaderboard <auditJson...> [--out <file>]
                              merge N \`audit --json\` files into one self-contained
                              AI-readiness leaderboard page ranking the audited systems
                              (default output: leaderboard.html). Duplicate system ids
                              across files are refused.
  ci [--run <dir>] [--baseline <file>] [--fail-on regression|fail] [--freeze]
                              gate a run against a frozen baseline
  prune [--apply] [--run <dir>] [--older-than 7d] [--keep N] [--deep] [--force]
                              preview (default) or delete per-cell workspace/ copies.
                              Never runs automatically. Skips in-flight runs and runs
                              that still have timeout/error/pending cells so you can
                              --resume / --retry-errored first. --apply actually deletes.
                              --force overrides the skip. --deep also drops files/.

First run, start to finish:
  tsx src/cli.ts init                 # describe your design system
  tsx src/cli.ts extract              # build its catalog from source
  tsx src/cli.ts audit                # AI-Readiness Score, no API key needed
  tsx src/cli.ts run --profile smoke  # a 2-cell benchmark sanity pass (costs LLM money)`;

function list(v: string | undefined): string[] | undefined {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

function loadResults(runDir: string): RunResults {
  return JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as RunResults;
}

function printAuditHuman(system: SystemId, checks: Awaited<ReturnType<typeof import('./audit/run.ts').runAuditChecks>>, score: ReturnType<typeof import('./audit/score.ts').computeAuditScore>, verbose: boolean): void {
  console.log(`\n== ${system} ==`);
  for (const check of checks) {
    const scoreStr = check.score === null ? ' n/a' : check.score.toFixed(1).padStart(5);
    console.log(`  ${scoreStr}  ${check.title}`);
    for (const f of check.findings) {
      if (f.severity === 'info' && !verbose) continue;
      console.log(`         [${f.severity}] ${f.message}`);
      if (f.fix) console.log(`                fix: ${f.fix}`);
    }
  }

  console.log(`\n  AI-Readiness Score (basis: ${score.basis})`);
  const line = (label: string, sub: { score: number | null; raw?: number; note: string }) => {
    const val = sub.score === null ? 'n/a' : sub.score.toFixed(1);
    const rawStr = sub.raw !== undefined ? ` (raw ${sub.raw >= 0 ? '+' : ''}${sub.raw})` : '';
    console.log(`    ${label.padEnd(22)} ${val}${rawStr}`);
    if (verbose || sub.score === null) console.log(`      ${sub.note}`);
  };
  line('Surface', { score: score.surface.score, note: `weighted mean of ${score.surface.checks.filter((c) => c.score !== null).length}/${score.surface.checks.length} scoreable checks` });
  line('Lift', score.lift);
  line('Ceiling', score.ceiling);
  line('Engagement', score.engagement);
  line('Vocabulary-behavioral', score.vocabularyBehavioral);
  console.log(`    ${'Composite'.padEnd(22)} ${score.composite.toFixed(1)}`);
  console.log(`    Tier: ${score.tier} (${score.tierRationale})`);
}

async function cmdAudit(opts: {
  configPathArg?: string;
  systemArg?: string;
  runDirArg?: string;
  json: boolean;
  verbose: boolean;
  offline: boolean;
}): Promise<number> {
  const { runAuditChecks, resolveHostedSurface } = await import('./audit/run.ts');
  const { computeAuditScore } = await import('./audit/score.ts');

  const systemsConfigPath = resolveSystemsConfigPath(opts.configPathArg);
  let systems: ReturnType<typeof loadSystems>;
  try {
    systems = loadSystems(systemsConfigPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  const targetSystems = (opts.systemArg ? [opts.systemArg] : Object.keys(systems)) as SystemId[];
  for (const s of targetSystems) {
    if (!systems[s]) {
      console.error(`unknown system "${s}" (known: ${Object.keys(systems).join(', ')})`);
      return 2;
    }
  }
  if (targetSystems.length === 0) {
    console.error(`no systems configured in ${systemsConfigPath}`);
    return 2;
  }

  const { catalogsDir, tokensDir } = resolveDataDirs(systemsConfigPath);

  let run: RunResults | undefined;
  if (opts.runDirArg) {
    const resultsPath = join(opts.runDirArg, 'results.json');
    if (!existsSync(resultsPath)) {
      console.error(`no results.json found at ${resultsPath}`);
      return 2;
    }
    try {
      run = JSON.parse(readFileSync(resultsPath, 'utf8')) as RunResults;
    } catch (err) {
      console.error(`failed to parse ${resultsPath}: ${err instanceof Error ? err.message : err}`);
      return 2;
    }
  }

  const report: Record<string, unknown> = { systemsConfigPath, run: opts.runDirArg ?? null, systems: {} as Record<string, unknown> };
  for (const system of targetSystems) {
    const cfg = systems[system];
    // Resolved once here (not inside runAuditChecks a second time — passing
    // it through dirs.hosted below means runAuditChecks reuses this exact
    // result instead of re-probing) so the JSON report can carry it too.
    // `hosted` is additive: src/report/leaderboard.ts only reads
    // `checks`/`score` from this shape, so this can't break its parsing.
    const hosted = await resolveHostedSurface(cfg, opts.offline);
    const checks = await runAuditChecks(system, cfg, { catalogsDir, tokensDir, hosted }, opts.offline);
    const score = computeAuditScore(checks, run, system);
    (report.systems as Record<string, unknown>)[system] = { checks, score, hosted };
    if (!opts.json) printAuditHuman(system, checks, score, opts.verbose);
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
  }
  return 0; // informational — the `ci` command is the gate, not this one
}

/**
 * One HEAD request to a system's docsUrl, 5s timeout — a cheap "is the
 * hosted docs host even up" sanity check, distinct from (and much cheaper
 * than) the four-path hosted-surface probe `audit` does (see hosted.ts).
 * Any actual HTTP response (even a non-2xx one) counts as reachable: this
 * is checking network reachability of the docs host, not the presence of
 * any specific asset on it.
 */
async function probeDocsUrlHead(docsUrl: string, timeoutMs = 5000): Promise<{ reachable: boolean; status?: number; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(docsUrl, { method: 'HEAD', signal: controller.signal });
    return { reachable: true, status: res.status };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// report --stats / report --validate
//
// The report artifact is markdown. `--stats` computes every number in it so an
// authoring agent never has to; `--validate` recomputes them and refuses a
// document whose figures do not trace back to the run.
// ---------------------------------------------------------------------------

type ReportStatsModule = typeof import('./report/stats.ts');

interface StatsContext {
  ok: true;
  stats: ReturnType<ReportStatsModule['buildReportStats']>;
  run: RunResults;
  generatedFrontMatter: Record<string, unknown>;
  systemId: SystemId;
  systemRoot: string;
  catalog: SystemCatalog | null;
}

interface StatsFailure {
  ok: false;
  message: string;
  code: number;
}

async function buildStatsContext(
  runDir: string,
  systemArg: string | undefined,
  configPathArg: string | undefined,
): Promise<StatsContext | StatsFailure> {
  const { runAuditChecks } = await import('./audit/run.ts');
  const { computeAuditScore } = await import('./audit/score.ts');
  const { buildReportStats, buildGeneratedFrontMatter } = await import('./report/stats.ts');

  const systemsConfigPath = resolveSystemsConfigPath(configPathArg);
  let systems: ReturnType<typeof loadSystems>;
  try {
    systems = loadSystems(systemsConfigPath);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), code: 2 };
  }

  const resultsPath = join(runDir, 'results.json');
  if (!existsSync(resultsPath)) {
    return { ok: false, message: `no results.json found at ${resultsPath}`, code: 2 };
  }
  let run: RunResults;
  try {
    run = loadResults(runDir);
  } catch (err) {
    return { ok: false, message: `failed to parse ${resultsPath}: ${err instanceof Error ? err.message : err}`, code: 2 };
  }

  const inRun = [...new Set(run.records.map((r) => r.cell.system))];
  let systemId: SystemId;
  if (systemArg) {
    systemId = systemArg as SystemId;
    if (!inRun.includes(systemId)) {
      return { ok: false, message: `run ${run.runId} has no cells for system "${systemId}" (has: ${inRun.join(', ')})`, code: 2 };
    }
  } else if (inRun.length === 1) {
    systemId = inRun[0];
  } else if (inRun.length === 0) {
    return { ok: false, message: `run ${run.runId} has no cell records`, code: 2 };
  } else {
    // A report describes one design system. Picking for the operator would
    // silently produce a report about half a run.
    return {
      ok: false,
      message: `run ${run.runId} covers ${inRun.length} systems (${inRun.join(', ')}); a report is per-system, so pass --system <id>`,
      code: 2,
    };
  }

  const cfg = systems[systemId];
  if (!cfg) {
    return { ok: false, message: `system "${systemId}" is in the run but not declared in ${systemsConfigPath}`, code: 2 };
  }

  const { catalogsDir, tokensDir } = resolveDataDirs(systemsConfigPath);
  const checks = await runAuditChecks(systemId, cfg, { catalogsDir, tokensDir });
  const score = computeAuditScore(checks, run, systemId);

  const { loadCatalogIfPresent } = await import('./report/figures.ts');
  const catalog = loadCatalogIfPresent(catalogsDir, systemId);
  let extraction: ReturnType<ReportStatsModule['buildReportStats']>['extraction'] = null;
  if (catalog) {
    const tPath = tokensPath(systemId, tokensDir);
    let cssVars = 0;
    let utilities = 0;
    if (existsSync(tPath)) {
      try {
        const tokens = JSON.parse(readFileSync(tPath, 'utf8')) as { cssVars?: string[]; utilities?: string[] };
        cssVars = tokens.cssVars?.length ?? 0;
        utilities = tokens.utilities?.length ?? 0;
      } catch {
        // A malformed token snapshot is the extractor's problem, not the
        // report's: fall back to zeroes rather than refusing to report.
      }
    }
    extraction = {
      components: catalog.components.length,
      exports: catalog.allExports.length,
      props: Object.values(catalog.allPropsByExport).reduce((sum, p) => sum + p.length, 0),
      cssVars,
      utilities,
    };
  }

  const stats = buildReportStats(run, systemId, cfg, checks, score, extraction);
  return {
    ok: true,
    stats,
    run,
    generatedFrontMatter: buildGeneratedFrontMatter(stats, run),
    systemId,
    systemRoot: cfg.root,
    catalog,
  };
}

async function cmdReportStats(opts: {
  runDir: string;
  systemArg?: string;
  configPathArg?: string;
  sinceArg?: string;
  outArg?: string;
}): Promise<number> {
  const { renderStatsPack } = await import('./report/stats.ts');
  const { parsePriorFindings } = await import('./report/document.ts');

  const ctx = await buildStatsContext(opts.runDir, opts.systemArg, opts.configPathArg);
  if (!ctx.ok) {
    console.error(ctx.message);
    return ctx.code;
  }

  let prior = null;
  if (opts.sinceArg) {
    if (!existsSync(opts.sinceArg)) {
      console.error(`--since file not found: ${opts.sinceArg}`);
      return 2;
    }
    try {
      prior = parsePriorFindings(readFileSync(opts.sinceArg, 'utf8'), opts.sinceArg);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
  }

  const pack = renderStatsPack(ctx.stats, ctx.generatedFrontMatter, prior);
  if (opts.outArg) {
    writeFileSync(opts.outArg, `${pack}\n`);
    console.log(`wrote ${opts.outArg}`);
  } else {
    console.log(pack);
  }
  return 0;
}

async function cmdReportValidate(opts: { filePath: string; configPathArg?: string }): Promise<number> {
  const { loadReportSchema, parseReportFrontMatter, validateReport, ReportParseError } = await import('./report/document.ts');

  if (!existsSync(opts.filePath)) {
    console.error(`report not found: ${opts.filePath}`);
    return 2;
  }
  const markdown = readFileSync(opts.filePath, 'utf8');

  let primaryRunId: string | null = null;
  try {
    const parsed = parseReportFrontMatter(markdown, opts.filePath);
    const fm = parsed.frontMatter as { provenance?: { runs?: Array<{ runId?: string; role?: string }> } };
    primaryRunId = fm.provenance?.runs?.find((r) => r.role === 'primary')?.runId ?? null;
  } catch (err) {
    if (err instanceof ReportParseError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  // Reports outlive runs. A missing run directory downgrades the data gates to
  // warnings instead of failing a report that was valid when it was written.
  let context = null;
  let sourceRoots = [PKG_ROOT];
  let catalog: SystemCatalog | null = null;
  if (primaryRunId) {
    const runDir = join(paths.runsDir, primaryRunId);
    if (existsSync(join(runDir, 'results.json'))) {
      const ctx = await buildStatsContext(runDir, undefined, opts.configPathArg);
      if (ctx.ok) {
        context = { stats: ctx.stats, run: ctx.run, generatedFrontMatter: ctx.generatedFrontMatter };
        sourceRoots = [ctx.systemRoot, PKG_ROOT];
        catalog = ctx.catalog;
      } else {
        console.error(`note: could not rebuild run data (${ctx.message}); validating structure only`);
      }
    }
  }

  const result = validateReport({
    filename: opts.filePath,
    markdown,
    schema: loadReportSchema(paths.reportSchema),
    context,
    sourceRoots,
    catalog,
  });

  for (const w of result.warnings) console.log(`  warn  [${w.gate}] ${w.message}`);
  for (const e of result.errors) console.error(`  FAIL  [${e.gate}] ${e.message}`);

  if (result.errors.length > 0) {
    console.error(`\n${opts.filePath}: ${result.errors.length} error${result.errors.length === 1 ? '' : 's'}, ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}`);
    return 1;
  }
  console.log(
    `\n${opts.filePath}: valid${result.degraded ? ' (structure only, run data unavailable)' : ''}` +
      `${result.warnings.length > 0 ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? '' : 's'}` : ''}`,
  );
  return 0;
}

async function cmdDoctor(configPathArg: string | undefined, tasksDirArg: string | undefined): Promise<number> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const okLines: string[] = [];

  const major = Number(process.version.slice(1).split('.')[0]);
  if (major < 20) problems.push(`node ${process.version} — need >=20`);
  else if (major < 22) warnings.push(`node ${process.version} — some systems may target node 22; typechecking may differ`);
  else okLines.push(`node ${process.version}`);

  const systemsConfigPath = resolveSystemsConfigPath(configPathArg);
  if (!existsSync(systemsConfigPath)) {
    problems.push(
      `systems config not found at ${systemsConfigPath}. Copy/edit systems.config.json (see README) or pass --config <path>.`,
    );
    for (const l of okLines) console.log(`  ok   ${l}`);
    for (const p of problems) console.log(`  FAIL ${p}`);
    console.log('\ndoctor: problems found');
    return 2;
  }

  const systems = loadSystems(systemsConfigPath);
  const { catalogsDir, tokensDir } = resolveDataDirs(systemsConfigPath);
  const { extractSystemTokens } = await import('./extract/tokens.ts');
  const { hashPaths, gitCommit } = await import('./extract/normalize.ts');
  for (const system of Object.keys(systems) as SystemId[]) {
    const cfg = systems[system];
    if (!existsSync(cfg.root)) {
      problems.push(`${system}: root not found at ${cfg.root} (set ${cfg.rootEnv}, or edit "root" in ${systemsConfigPath})`);
      continue;
    }
    if (!existsSync(join(cfg.root, 'node_modules'))) {
      warnings.push(`${system}: node_modules missing in ${cfg.root} — install the system's own deps first`);
    }
    okLines.push(`${system}: ${cfg.root} @ ${gitCommit(cfg.root).slice(0, 8)}`);

    if (!cfg.foundationsCss) {
      warnings.push(`${system}: no foundationsCss configured — token-based checks (contamination casing) are limited`);
    }

    if (!existsSync(catalogPath(system, catalogsDir)) || !existsSync(tokensPath(system, tokensDir))) {
      warnings.push(`${system}: catalogs/tokens not extracted yet — run "npm run extract"`);
    } else {
      const catalog = JSON.parse(readFileSync(catalogPath(system, catalogsDir), 'utf8')) as SystemCatalog;
      if (hashPaths(cfg.root, [cfg.componentsSrc]) !== catalog.source.srcHash) {
        warnings.push(`${system}: catalog is stale vs the live checkout — re-run "npm run extract"`);
      }
      const liveTokens = await extractSystemTokens(system, cfg);
      const stored = JSON.parse(readFileSync(tokensPath(system, tokensDir), 'utf8')) as { cssHash: string };
      if (liveTokens.cssHash !== stored.cssHash) {
        warnings.push(`${system}: tokens are stale vs the live foundations css — re-run "npm run extract"`);
      }
    }
    const { templateDir } = await import('./run/fixture.ts');
    if (!existsSync(join(templateDir(system, cfg), 'node_modules'))) {
      warnings.push(`${system}: fixture template not installed yet (auto-installs on first run)`);
    }

    if (cfg.docsUrl) {
      const probe = await probeDocsUrlHead(cfg.docsUrl);
      if (probe.reachable) {
        okLines.push(`${system}: docsUrl reachable (${cfg.docsUrl}, HTTP ${probe.status})`);
      } else {
        warnings.push(
          `${system}: docsUrl not reachable (${cfg.docsUrl}): ${probe.error} — \`audit\`'s hosted-surface probes will report unmeasured, not absent, until this resolves`,
        );
      }
    } else {
      okLines.push(`${system}: no docsUrl configured — audit's hosted-surface probes stay disabled (fully offline)`);
    }
  }

  const { getAdapter } = await import('./agents/registry.ts');
  const det = await getAdapter('claude-code').detect();
  if (!det.ok) problems.push(`claude CLI not available: ${det.error}`);
  else {
    okLines.push(`claude CLI ${det.version}`);
    try {
      const { stdout } = await execFileP(
        'claude',
        ['-p', '--output-format', 'json', '--model', 'haiku', '--tools', '', '--strict-mcp-config', 'say ok'],
        { timeout: 60_000 },
      );
      const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
      const env = line ? (JSON.parse(line) as { is_error?: boolean }) : undefined;
      if (!env || env.is_error) problems.push('claude headless probe failed (is_error)');
      else okLines.push('claude headless probe ok');
    } catch (err) {
      problems.push(`claude headless probe failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const bench = loadBenchConfig();
  const providerEntries = Object.entries(bench.providers ?? {});
  if (providerEntries.length === 0) {
    okLines.push('providers: none configured (bench.config.json has no "providers" — only the claude CLI flow is available)');
  } else {
    for (const [id, cfg] of providerEntries) {
      const set = !!process.env[cfg.apiKeyEnv];
      const line = `provider "${id}" (kind: ${cfg.kind}, baseUrl: ${cfg.baseUrl}): ${cfg.apiKeyEnv} ${set ? 'is set' : 'is NOT set'}`;
      if (set) okLines.push(line);
      else warnings.push(`${line} — qualified models/judging for this provider will fail until it is`);
    }
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    okLines.push(`claude CLI generation routed via gateway: ${process.env.ANTHROPIC_BASE_URL}`);
  }

  try {
    const { loadTasks, validateTaskSuite } = await import('./tasks/load.ts');
    const tasksDir = resolveTasksDir(bench, tasksDirArg);
    // Every configured system gets a key, even when its catalog isn't
    // extracted yet (value undefined) — a task with no explicit "systems"
    // list infers its scope from Object.keys(catalogs), so a system missing
    // its key entirely (rather than mapping to undefined) would silently
    // drop out of that scope instead of surfacing a "not extracted" warning.
    const catalogs: Partial<Record<SystemId, SystemCatalog>> = {};
    for (const system of Object.keys(systems) as SystemId[]) {
      catalogs[system] = existsSync(catalogPath(system, catalogsDir))
        ? (JSON.parse(readFileSync(catalogPath(system, catalogsDir), 'utf8')) as SystemCatalog)
        : undefined;
    }
    const res = validateTaskSuite(loadTasks(tasksDir), catalogs);
    if (res.errors.length) problems.push(...res.errors.map((e) => `tasks: ${e}`));
    else okLines.push(`task suite valid (${res.warnings.length} warnings)`);
  } catch (err) {
    problems.push(`task suite failed to load: ${err instanceof Error ? err.message : err}`);
  }

  for (const l of okLines) console.log(`  ok   ${l}`);
  for (const w of warnings) console.log(`  warn ${w}`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  console.log(problems.length ? '\ndoctor: problems found' : '\ndoctor: ready');
  return problems.length ? 2 : 0;
}

async function main(): Promise<number> {
  // Keys and gateway settings can live in <package root>/.env (gitignored;
  // see .env.example) instead of shell exports. Real environment wins.
  const { loadDotEnv } = await import('./config.ts');
  const dotEnvLoaded = loadDotEnv();

  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  if (dotEnvLoaded && cmd === 'doctor') console.log('  ok   loaded .env from the package root');

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'tasks-dir': { type: 'string' },
      'non-interactive': { type: 'boolean' },
      id: { type: 'string' },
      consume: { type: 'string' },
      package: { type: 'string' },
      root: { type: 'string' },
      'components-src': { type: 'string' },
      'css-entry': { type: 'string' },
      'docs-url': { type: 'string' },
      'allow-stale': { type: 'boolean' },
      systems: { type: 'string' },
      contexts: { type: 'string' },
      models: { type: 'string' },
      tasks: { type: 'string' },
      reps: { type: 'string' },
      profile: { type: 'string' },
      concurrency: { type: 'string' },
      'no-judge': { type: 'boolean' },
      'judge-model': { type: 'string' },
      'judge-samples': { type: 'string' },
      'judge-provider': { type: 'string' },
      label: { type: 'string' },
      resume: { type: 'string' },
      'retry-errored': { type: 'boolean' },
      wait: { type: 'boolean' },
      run: { type: 'string' },
      baseline: { type: 'string' },
      'fail-on': { type: 'string' },
      freeze: { type: 'boolean' },
      out: { type: 'string' },
      'older-than': { type: 'string' },
      keep: { type: 'string' },
      deep: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      force: { type: 'boolean' },
      system: { type: 'string' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      offline: { type: 'boolean' },
      stats: { type: 'boolean' },
      validate: { type: 'string' },
      since: { type: 'string' },
    },
  });

  switch (cmd) {
    case 'doctor':
      return cmdDoctor(values.config, values['tasks-dir']);

    case 'init': {
      const { runInit } = await import('./init/wizard.ts');
      const nonInteractive = values['non-interactive'] ?? false;
      const consume = values.consume as 'npm' | 'source' | undefined;
      if (nonInteractive && consume && !['npm', 'source'].includes(consume)) {
        console.error('--consume must be "npm" or "source"');
        return 2;
      }
      const { configPath, summary } = await runInit({
        nonInteractive,
        answers: {
          ...(values.id ? { systemId: values.id } : {}),
          ...(consume ? { consume } : {}),
          ...(values.package ? { packageSpec: values.package } : {}),
          ...(values.root ? { root: values.root } : {}),
          ...(values['components-src'] ? { componentsSrc: values['components-src'] } : {}),
          ...(values['css-entry'] ? { cssEntry: values['css-entry'] } : {}),
          ...(values['docs-url'] ? { docsUrl: values['docs-url'] } : {}),
        },
      });
      console.log(summary);
      console.log(`config: ${configPath}`);
      return summary.startsWith('aborted') ? 2 : 0;
    }

    case 'audit':
      return cmdAudit({
        configPathArg: values.config,
        systemArg: values.system,
        runDirArg: values.run,
        json: values.json ?? false,
        verbose: values.verbose ?? false,
        offline: values.offline ?? false,
      });

    case 'extract': {
      const { runExtract } = await import('./extract/index.ts');
      const systemsConfigPath = resolveSystemsConfigPath(values.config);
      const { catalogsDir, tokensDir } = resolveDataDirs(systemsConfigPath);
      const failedCount = await runExtract({
        systems: list(values.systems) as SystemId[] | undefined,
        allowStale: values['allow-stale'] ?? false,
        configPath: systemsConfigPath,
        catalogsDir,
        tokensDir,
      });
      return failedCount > 0 ? 1 : 0;
    }

    case 'validate-tasks': {
      const { loadTasks, validateTaskSuite } = await import('./tasks/load.ts');
      const bench = loadBenchConfig();
      const systemsConfigPath = resolveSystemsConfigPath(values.config);
      const systems = loadSystems(systemsConfigPath);
      const { catalogsDir } = resolveDataDirs(systemsConfigPath);
      const tasksDir = resolveTasksDir(bench, values['tasks-dir']);
      // Every configured system gets a key, even when its catalog isn't
      // extracted yet (value undefined) — see the matching comment in
      // cmdDoctor for why this matters for tasks with no explicit "systems".
      const catalogs: Partial<Record<SystemId, SystemCatalog>> = {};
      for (const system of Object.keys(systems) as SystemId[]) {
        catalogs[system] = existsSync(catalogPath(system, catalogsDir))
          ? (JSON.parse(readFileSync(catalogPath(system, catalogsDir), 'utf8')) as SystemCatalog)
          : undefined;
      }
      const res = validateTaskSuite(loadTasks(tasksDir), catalogs);
      for (const w of res.warnings) console.log(`  warn ${w}`);
      for (const e of res.errors) console.log(`  FAIL ${e}`);
      console.log(res.errors.length ? '\ninvalid task suite' : '\ntask suite ok');
      return res.errors.length ? 1 : 0;
    }

    case 'run': {
      const { runBench } = await import('./run/runner.ts');
      const bench = loadBenchConfig();
      const resumeDir = values.resume;
      let profile: string | undefined;
      if (!resumeDir) {
        profile = values.profile ?? 'smoke';
        if (!bench.profiles[profile]) {
          console.error(`unknown profile "${profile}" (known: ${Object.keys(bench.profiles).join(', ')})`);
          return 2;
        }
      }
      const { runDir, results, paused } = await runBench({
        profile,
        resumeDir,
        retryErrored: values['retry-errored'] ?? false,
        waitForCredits: values.wait ?? false,
        configPath: values.config,
        tasksDir: values['tasks-dir'],
        filters: {
          systems: list(values.systems) as SystemId[] | undefined,
          contexts: list(values.contexts) as ContextLevel[] | undefined,
          models: list(values.models),
          tasks: list(values.tasks),
          reps: values.reps ? Number(values.reps) : undefined,
        },
        concurrency: values.concurrency ? Number(values.concurrency) : undefined,
        noJudge: values['no-judge'] ?? false,
        judgeModel: values['judge-model'],
        judgeSamples: values['judge-samples'] ? Number(values['judge-samples']) : undefined,
        judgeProvider: values['judge-provider'],
        label: values.label,
      });
      // On a paused finish, runBench already printed the done/pending summary
      // and the exact resume command — nothing more to add here.
      if (paused) return 3;
      const ok = results.records.filter((r) => r.status === 'ok').length;
      const bad = results.records.filter((r) => r.status === 'agent-error' || r.status === 'timeout').length;
      console.log(`\nrun ${results.runId}: ${ok} ok, ${bad} errored, ${results.records.length - ok - bad} skipped`);
      console.log(`report: ${join(runDir, 'report.html')} (serve via launch config "open-design-system-bench", port 4189)`);
      return bad === results.records.length ? 3 : 0;
    }

    case 'grade':
    case 'judge': {
      const { regradeRun, latestRunDir } = await import('./run/runner.ts');
      const runDir = values.run ?? latestRunDir();
      if (!runDir || !existsSync(join(runDir, 'results.json'))) {
        console.error('no run found — pass --run <dir>');
        return 2;
      }
      await regradeRun({
        runDir,
        judge: cmd === 'judge',
        judgeModel: values['judge-model'],
        judgeSamples: values['judge-samples'] ? Number(values['judge-samples']) : undefined,
        judgeProvider: values['judge-provider'],
        configPath: values.config,
      });
      console.log(`re-scored ${runDir}`);
      return 0;
    }

    case 'report': {
      if (values.validate !== undefined) {
        const filePath = typeof values.validate === 'string' && values.validate ? values.validate : positionals[0];
        if (!filePath) {
          console.error('report --validate needs a .report.md path');
          return 2;
        }
        return cmdReportValidate({ filePath, configPathArg: values.config });
      }

      const { latestRunDir } = await import('./run/runner.ts');
      const runDir = values.run ?? latestRunDir();
      if (!runDir) {
        console.error('no run found — pass --run <dir>');
        return 2;
      }

      if (values.stats) {
        return cmdReportStats({
          runDir,
          systemArg: values.system,
          configPathArg: values.config,
          sinceArg: values.since,
          outArg: values.out,
        });
      }

      const { renderReportHtml } = await import('./report/html.ts');
      writeFileSync(join(runDir, 'report.html'), renderReportHtml(loadResults(runDir)));
      console.log(`wrote ${join(runDir, 'report.html')}`);
      return 0;
    }

    case 'compare': {
      const { renderCompareHtml } = await import('./report/compare.ts');
      if (positionals.length < 2) {
        console.error('compare needs at least two run directories');
        return 2;
      }
      const runs = positionals.map(loadResults);
      const out = values.out ?? join(positionals[0], 'compare.html');
      writeFileSync(out, renderCompareHtml(runs));
      console.log(`wrote ${out}`);
      return 0;
    }

    case 'leaderboard': {
      const { collectLeaderboardEntries, renderLeaderboardHtml } = await import('./report/leaderboard.ts');
      type AuditReportFile = import('./report/leaderboard.ts').AuditReportFile;
      if (positionals.length < 1) {
        console.error('leaderboard needs at least one audit JSON file (produce one with `audit --json > file.json`)');
        return 2;
      }
      const files: { path: string; report: AuditReportFile }[] = [];
      for (const p of positionals) {
        if (!existsSync(p)) {
          console.error(`no such file: ${p}`);
          return 2;
        }
        try {
          files.push({ path: p, report: JSON.parse(readFileSync(p, 'utf8')) as AuditReportFile });
        } catch (err) {
          console.error(`failed to parse ${p}: ${err instanceof Error ? err.message : err}`);
          return 2;
        }
      }
      let html: string;
      let count: number;
      try {
        const entries = collectLeaderboardEntries(files);
        count = entries.length;
        html = renderLeaderboardHtml(entries);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 2;
      }
      const out = values.out ?? 'leaderboard.html';
      writeFileSync(out, html);
      console.log(`wrote ${out} (${count} systems)`);
      return 0;
    }

    case 'ci': {
      const { latestRunDir } = await import('./run/runner.ts');
      const { ciCheck } = await import('./report/ci.ts');
      const bench = loadBenchConfig();
      const runDir = values.run ?? latestRunDir();
      if (!runDir) {
        console.error('no run found — pass --run <dir>');
        return 2;
      }
      const current = loadResults(runDir);
      const baselinePath = values.baseline ?? join(paths.baselinesDir, 'baseline.json');
      if (values.freeze) {
        mkdirSync(paths.baselinesDir, { recursive: true });
        copyFileSync(join(runDir, 'results.json'), baselinePath);
        console.log(`froze ${runDir} → ${baselinePath}`);
        return 0;
      }
      const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as RunResults) : null;
      const failOn = (values['fail-on'] ?? 'regression') as 'regression' | 'fail';
      if (!['regression', 'fail'].includes(failOn)) {
        console.error('--fail-on must be "regression" or "fail"');
        return 2;
      }
      const outcome = ciCheck(current, baseline, {
        maxScoreDrop: bench.ci.maxScoreDrop,
        maxErroredCellRatio: bench.ci.maxErroredCellRatio,
        failOn,
      });
      console.log(outcome.summary);
      return outcome.exitCode;
    }

    case 'prune': {
      const { pruneRuns, parseAge, formatBytes } = await import('./run/prune.ts');
      let olderThanMs: number | undefined;
      if (values['older-than']) {
        try {
          olderThanMs = parseAge(values['older-than']);
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
          return 2;
        }
      }
      const result = pruneRuns({
        runDir: values.run,
        olderThanMs,
        keep: values.keep != null ? Number(values.keep) : undefined,
        deep: values.deep ?? false,
        dryRun: values.apply !== true || values['dry-run'] === true,
        force: values.force ?? false,
      });
      const verb = result.dryRun ? 'would remove' : 'removed';
      console.log(
        `${verb} ${result.removed.length} path(s) · ${formatBytes(result.bytes)} · ${result.runDirs.length} run(s)`,
      );
      for (const s of result.skipped) {
        console.log(`  skip ${s.dir} — ${s.reason}`);
      }
      if (result.dryRun) {
        for (const p of result.removed.slice(0, 20)) console.log(`  ${p}`);
        if (result.removed.length > 20) console.log(`  … ${result.removed.length - 20} more`);
      }
      return 0;
    }

    default:
      console.error(`unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(2);
  },
);
