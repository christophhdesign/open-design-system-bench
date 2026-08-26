import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  catalogPath,
  loadBenchConfig,
  loadSystems,
  paths,
  resolveDataDirs,
  resolveSystemsConfigPath,
  resolveTasksDir,
  tokensPath,
} from '../config.ts';
import type {
  BenchConfig,
  CellRecord,
  CellSpec,
  DimensionResult,
  SystemCatalog,
  SystemConfig,
  SystemId,
  SystemTokens,
  SystemsConfig,
  RunManifest,
  RunResults,
  Task,
  TokenUsage,
} from '../types.ts';
import { cellKey } from '../types.ts';
import { loadTasks } from '../tasks/load.ts';
import { expandMatrix, type MatrixFilters } from './matrix.ts';
import { provisionWorkspace, prepareTemplate, pruneWorkspace, ensureWorkspaceNodeModules } from './fixture.ts';
import { collectArtifacts } from './collect.ts';
import { getAdapter } from '../agents/registry.ts';
import { UsageLimitError, looksLikeUsageLimit } from '../agents/errors.ts';
import { parseModelSpec } from '../providers/model-spec.ts';
import { estimateApiCostUsd } from '../providers/pricing.ts';
import { analyzeSource } from '../grade/ast.ts';
import type { AnalyzedFile, GradeContext } from '../grade/context.ts';
import { runMechanical, composeResult } from '../grade/score.ts';
import { judgeArtifact } from '../grade/judge.ts';
import { buildRunResults } from '../report/aggregate.ts';
import { renderReportHtml } from '../report/html.ts';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  /** Required unless resumeDir is set — the stored manifest's profile wins on resume. */
  profile?: string;
  filters?: MatrixFilters;
  concurrency?: number;
  noJudge?: boolean;
  judgeModel?: string;
  judgeSamples?: number;
  judgeProvider?: string;
  label?: string;
  /** Resume a previously paused/interrupted run instead of starting a fresh one. */
  resumeDir?: string;
  /** On a usage-limit pause, sleep and probe for renewed credits instead of finishing paused. */
  waitForCredits?: boolean;
  /** Resume only: also re-queue cells that finished as timeout/agent-error, not just pending ones. */
  retryErrored?: boolean;
  /** --config override: which systems config file to load. */
  configPath?: string;
  /** --tasks-dir override: which task suite dir to load (else bench.config defaults.tasksDir, else ./tasks). */
  tasksDir?: string;
}

const GRADEABLE_EXT = /\.(tsx|ts|jsx|js)$/;

/** Marks a manifest.cells entry as not-yet-completed — resume treats any skipReason with this prefix as pending. */
const PAUSED_PREFIX = 'paused:';
const NOT_STARTED_REASON = 'paused: not yet run — resume to run';
const USAGE_LIMIT_REASON = 'paused: usage limit — resume to run';

type ManifestCellEntry = RunManifest['cells'][number];

interface SystemAssets {
  catalog: SystemCatalog;
  tokens: SystemTokens;
}

function loadSystemAssets(system: SystemId, catalogsDir: string, tokensDir: string): SystemAssets {
  const cat = catalogPath(system, catalogsDir);
  const tok = tokensPath(system, tokensDir);
  if (!existsSync(cat) || !existsSync(tok)) {
    throw new Error(`ground truth missing for ${system} — run "npm run extract" first`);
  }
  return {
    catalog: JSON.parse(readFileSync(cat, 'utf8')) as SystemCatalog,
    tokens: JSON.parse(readFileSync(tok, 'utf8')) as SystemTokens,
  };
}

function buildSystemPrompt(context: CellSpec['context']): string {
  const base =
    'Implement the requested feature in this workspace (a Vite React TypeScript app). ' +
    'Put your implementation in src/task/ (see README.md). Do not modify files outside src/. ' +
    'Do not run dev servers or install packages.';
  // "bare" cells get one neutral pointer so the baseline measures doc quality,
  // not whether the agent thinks to look for a design system at all.
  return context === 'bare'
    ? `${base} Use the design system package available in this workspace.`
    : base;
}

/** Read the graders' input files from a cell's collected files/ directory. */
function readAnalyzedFiles(filesDir: string): AnalyzedFile[] {
  if (!existsSync(filesDir)) return [];
  const out: AnalyzedFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (GRADEABLE_EXT.test(entry.name)) {
        const source = readFileSync(p, 'utf8');
        out.push({ path: relative(filesDir, p), source, analysis: analyzeSource(p, source) });
      }
    }
  };
  walk(filesDir);
  return out;
}

/** compile grading needs the workspace's node_modules symlink; restore it for re-grades. */
function ensureNodeModules(workspaceDir: string, system: SystemId, cfg: SystemConfig): () => void {
  return ensureWorkspaceNodeModules(workspaceDir, system, cfg);
}

export async function gradeCell(opts: {
  spec: CellSpec;
  task: Task;
  systemsConfig: SystemsConfig;
  assets: SystemAssets;
  cellDir: string;
  diffPatch: string;
  noJudge: boolean;
  judgeModel: string;
  judgeSamples: number;
  judgeTimeoutMs: number;
  judgeProvider?: string;
}): Promise<{ dimensions: DimensionResult[]; judgeRaw?: unknown }> {
  const { spec, task, assets } = opts;
  const workspaceDir = join(opts.cellDir, 'workspace');
  const files = readAnalyzedFiles(join(opts.cellDir, 'files'));
  const ctx: GradeContext = {
    system: spec.system,
    systemCfg: opts.systemsConfig[spec.system],
    catalog: assets.catalog,
    tokens: assets.tokens,
    task,
    files,
    workspaceDir,
  };

  const cleanup = ensureNodeModules(workspaceDir, spec.system, opts.systemsConfig[spec.system]);
  let dimensions: DimensionResult[];
  try {
    dimensions = await runMechanical(ctx);
  } finally {
    cleanup();
  }

  let judgeRaw: unknown;
  if (!opts.noJudge) {
    if (!opts.diffPatch.trim()) {
      dimensions.push({
        dimension: 'judgment',
        score: 0,
        gate: 'review',
        diffs: [{ dimension: 'judgment', message: 'agent produced no changes — nothing to judge' }],
      });
    } else {
      const judge = await judgeArtifact({
        task,
        system: spec.system,
        catalog: assets.catalog,
        diffPatch: opts.diffPatch,
        model: opts.judgeModel,
        timeoutMs: opts.judgeTimeoutMs,
        samples: opts.judgeSamples,
        provider: opts.judgeProvider,
      });
      dimensions.push(judge.dimension);
      judgeRaw = { output: judge.output, rawSamples: judge.rawSamples, varianceNote: judge.varianceNote };
    }
  }
  return { dimensions, judgeRaw };
}

async function pool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const queue = [...items];
  const lanes = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      if (shouldStop()) break;
      const item = queue.shift();
      if (item === undefined) break;
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function specId(s: Pick<CellSpec, 'agent' | 'system' | 'context' | 'model' | 'taskId' | 'rep'>): string {
  return [s.agent, s.system, s.context, s.model, s.taskId, s.rep].join('|');
}

/** Best-effort agent cost/turns/tokens/duration from a cell's stored transcript. */
function agentMetaFromTranscript(transcriptPath: string): CellRecord['agentMeta'] {
  try {
    const raw = readFileSync(transcriptPath, 'utf8');
    try {
      const obj = JSON.parse(raw) as {
        provider?: unknown;
        model?: unknown;
        usage?: TokenUsage;
      };
      if (obj && typeof obj === 'object' && (obj.provider != null || obj.usage != null)) {
        const usage = obj.usage;
        const providerField = obj.provider;
        const providerId =
          typeof providerField === 'string'
            ? providerField
            : providerField &&
                typeof providerField === 'object' &&
                typeof (providerField as { id?: unknown }).id === 'string'
              ? (providerField as { id: string }).id
              : '';
        const model = typeof obj.model === 'string' ? obj.model : '';
        const costUsd =
          usage && model
            ? providerId
              ? estimateApiCostUsd(model, usage)
              : undefined
            : undefined;
        return {
          durationMs: 0,
          numTurns: 1,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          costUsd,
        };
      }
    } catch {
      // not a single JSON document — claude-code writes stream-json lines
    }
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.startsWith('{')) continue;
      const evt = JSON.parse(line) as { type?: string; duration_ms?: number; total_cost_usd?: number; num_turns?: number };
      if (evt.type === 'result') {
        return { durationMs: evt.duration_ms ?? 0, costUsd: evt.total_cost_usd, numTurns: evt.num_turns };
      }
    }
  } catch {
    /* unreadable transcript — meta is optional */
  }
  return undefined;
}

/**
 * Rebuild the completed-cell records of a run directory from its per-cell
 * artifacts. Needed to resume runs started before incremental persistence
 * existed (results.json was only written at the very end back then), and it
 * doubles as crash recovery when results.json is missing or corrupt.
 * A cell counts as done only if its grades.json is on disk; an agent-error
 * whose stored error text looks like a usage limit is treated as pending so
 * the resume retries it.
 */
function reconstructRecordsFromDisk(runDir: string, manifest: RunManifest): CellRecord[] {
  const records: CellRecord[] = [];
  for (const entry of manifest.cells) {
    const spec = entry.spec;
    if (entry.status === 'skipped' && entry.skipReason && !entry.skipReason.startsWith(PAUSED_PREFIX)) {
      records.push({
        cell: { system: spec.system, context: spec.context, model: spec.model, agent: spec.agent },
        taskId: spec.taskId,
        rep: spec.rep,
        status: 'skipped',
        skipReason: entry.skipReason,
      });
      continue;
    }
    const relCellDir = join('cells', cellKey(spec), spec.taskId, `rep${spec.rep}`);
    const cellDir = join(runDir, relCellDir);
    const gradesPath = join(cellDir, 'grades.json');
    const errorPath = join(cellDir, 'agent-error.txt');
    if (existsSync(gradesPath)) {
      const transcriptRel = join(relCellDir, 'transcript.jsonl');
      const diffRel = join(relCellDir, 'diff.patch');
      const judgeRel = join(relCellDir, 'judge.json');
      records.push({
        cell: { system: spec.system, context: spec.context, model: spec.model, agent: spec.agent },
        taskId: spec.taskId,
        rep: spec.rep,
        status: 'ok',
        agentMeta: agentMetaFromTranscript(join(runDir, transcriptRel)),
        artifacts: {
          dir: relCellDir,
          diffPatch: existsSync(join(runDir, diffRel)) ? diffRel : undefined,
          transcript: existsSync(join(runDir, transcriptRel)) ? transcriptRel : undefined,
          judgeJson: existsSync(join(runDir, judgeRel)) ? judgeRel : undefined,
        },
        result: JSON.parse(readFileSync(gradesPath, 'utf8')),
      });
    } else if (existsSync(errorPath) && !looksLikeUsageLimit(readFileSync(errorPath, 'utf8'))) {
      records.push({
        cell: { system: spec.system, context: spec.context, model: spec.model, agent: spec.agent },
        taskId: spec.taskId,
        rep: spec.rep,
        status: 'agent-error',
        artifacts: { dir: relCellDir },
      });
    }
    // otherwise: never started, in flight at interruption time, timed out, or
    // failed on a usage limit — all of these stay pending and get re-run.
  }
  return records;
}

/**
 * Cheap headless probe used by --wait to detect renewed usage credits: a
 * haiku completion with every tool disabled costs a small fraction of a cent,
 * so polling it every 10 minutes while paused is negligible next to the cost
 * of a single benchmark cell.
 */
async function probeCreditsAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', '--output-format', 'json', '--model', 'haiku', '--tools', '', '--strict-mcp-config', 'ok'],
      { timeout: 60_000 },
    );
    const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
    if (!line) return false;
    const env = JSON.parse(line) as { is_error?: boolean };
    return !env.is_error;
  } catch {
    return false;
  }
}

const WAIT_PROBE_INTERVAL_MS = 10 * 60 * 1_000;
const WAIT_MAX_MS = 8 * 60 * 60 * 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls probeCreditsAvailable every 10min for up to 8h. Resolves true iff credits came back in time. */
async function waitForCredits(): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < WAIT_MAX_MS) {
    await sleep(WAIT_PROBE_INTERVAL_MS);
    const elapsedMin = Math.round((Date.now() - start) / 60_000);
    const ok = await probeCreditsAvailable();
    console.log(`[wait] probe at +${elapsedMin}m: ${ok ? 'credits available again' : 'still limited'}`);
    if (ok) return true;
  }
  return false;
}

export async function runBench(
  opts: RunOptions,
): Promise<{ runDir: string; results: RunResults; paused?: boolean }> {
  const bench: BenchConfig = loadBenchConfig();
  const systemsConfigPath = resolveSystemsConfigPath(opts.configPath);
  const systemsConfig = loadSystems(systemsConfigPath);
  const { catalogsDir, tokensDir } = resolveDataDirs(systemsConfigPath);
  const tasksDir = resolveTasksDir(bench, opts.tasksDir);
  const tasks = loadTasks(tasksDir);
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  let runDir: string;
  let manifest: RunManifest;
  let records: CellRecord[];
  let cellStates: Map<string, ManifestCellEntry>;
  let initialPending: CellSpec[];
  const assetsBySystem = new Map<SystemId, SystemAssets>();

  if (opts.resumeDir) {
    // -------------------------------------------------------------------
    // RESUME: reconstruct state from the stored manifest/results and find
    // every cell that never finished (either it hit the usage limit, or it
    // was still queued when the run paused/crashed/was ctrl-C'd).
    // -------------------------------------------------------------------
    runDir = resolve(opts.resumeDir);
    const manifestPath = join(runDir, 'manifest.json');
    const resultsPath = join(runDir, 'results.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`--resume ${runDir}: manifest.json not found`);
    }
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;

    let priorRecords: CellRecord[];
    if (existsSync(resultsPath)) {
      priorRecords = (JSON.parse(readFileSync(resultsPath, 'utf8')) as RunResults).records;
    } else {
      // Run dir from a pre-incremental-persistence version (or a crash before
      // the first write): rebuild what completed from the per-cell artifacts.
      priorRecords = reconstructRecordsFromDisk(runDir, manifest);
      console.log(
        `[resume] no results.json in ${runDir} — reconstructed ` +
          `${priorRecords.filter((r) => r.status === 'ok').length} completed cell(s) from disk artifacts`,
      );
    }

    // Drop any lingering "paused" placeholder records — those never completed.
    records = priorRecords.filter((r) => !(r.status === 'skipped' && r.skipReason?.startsWith(PAUSED_PREFIX)));

    if (opts.retryErrored) {
      const requeue = records.filter((r) => r.status === 'timeout' || r.status === 'agent-error');
      if (requeue.length) {
        console.log(`[resume] --retry-errored: re-queuing ${requeue.length} timeout/agent-error cell(s)`);
        records = records.filter((r) => r.status !== 'timeout' && r.status !== 'agent-error');
      }
    }
    cellStates = new Map(manifest.cells.map((c) => [specId(c.spec), c]));

    const doneKeys = new Set(records.map((r) => specId({ ...r.cell, taskId: r.taskId, rep: r.rep })));
    initialPending = manifest.cells
      .filter((c) => c.skipReason?.startsWith(PAUSED_PREFIX) || !doneKeys.has(specId(c.spec)))
      .map((c) => c.spec);
  } else {
    // -------------------------------------------------------------------
    // FRESH RUN
    // -------------------------------------------------------------------
    const profileName = opts.profile;
    if (!profileName) throw new Error('profile is required unless --resume is given');
    const profile = bench.profiles[profileName];
    if (!profile) {
      throw new Error(`unknown profile "${profileName}" (known: ${Object.keys(bench.profiles).join(', ')})`);
    }

    const { cells, skipped } = expandMatrix(profile, bench, tasks, opts.filters);
    if (!cells.length) throw new Error('matrix expanded to zero runnable cells');

    const startedAt = new Date();
    const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    const runId = opts.label ? `${stamp}-${opts.label}` : stamp;
    runDir = join(paths.runsDir, runId);
    mkdirSync(runDir, { recursive: true });

    manifest = {
      runId,
      label: opts.label,
      profile: profileName,
      startedAt: startedAt.toISOString(),
      nodeVersion: process.version,
      adapters: {},
      systems: {},
      cells: [
        ...cells.map((spec) => ({ spec, status: 'skipped' as const, skipReason: NOT_STARTED_REASON })),
        ...skipped.map(({ spec, reason }) => ({ spec, status: 'skipped' as const, skipReason: reason })),
      ],
      totalCostUsd: 0,
    };

    records = skipped.map(({ spec, reason }) => ({
      cell: { system: spec.system, context: spec.context, model: spec.model, agent: spec.agent },
      taskId: spec.taskId,
      rep: spec.rep,
      status: 'skipped' as const,
      skipReason: reason,
    }));
    cellStates = new Map(manifest.cells.map((c) => [specId(c.spec), c]));
    initialPending = cells;

    const adapterIds = [...new Set(cells.map((c) => c.agent))];
    for (const id of adapterIds) {
      const det = await getAdapter(id).detect();
      if (!det.ok) throw new Error(`agent adapter "${id}" unavailable: ${det.error}`);
      manifest.adapters[id] = { version: det.version };
    }

    const systemsInvolved = [...new Set(cells.map((c) => c.system))];
    for (const system of systemsInvolved) {
      assetsBySystem.set(system, loadSystemAssets(system, catalogsDir, tokensDir));
      await prepareTemplate(system, systemsConfig[system]);
    }
    manifest.systems = Object.fromEntries(
      systemsInvolved.map((system) => {
        const a = assetsBySystem.get(system)!;
        return [
          system,
          {
            root: systemsConfig[system].root,
            commit: a.catalog.source.commit,
            catalogSrcHash: a.catalog.source.srcHash,
            tokensCssHash: a.tokens.cssHash,
          },
        ];
      }),
    );

    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  // System ground truth needed by whatever cells are actually about to run
  // (the fresh branch above already loaded its own systems; this only has
  // work left to do on a resume, whose pending systems weren't loaded yet).
  for (const system of new Set(initialPending.map((c) => c.system))) {
    if (assetsBySystem.has(system)) continue;
    assetsBySystem.set(system, loadSystemAssets(system, catalogsDir, tokensDir));
    await prepareTemplate(system, systemsConfig[system]);
  }

  if (opts.resumeDir && initialPending.length) {
    // Re-detect adapters used by the pending cells — cheap, and confirms the
    // claude CLI is actually reachable before diving into a resume attempt.
    const adapterIds = [...new Set(initialPending.map((c) => c.agent))];
    for (const id of adapterIds) {
      const det = await getAdapter(id).detect();
      if (!det.ok) throw new Error(`agent adapter "${id}" unavailable: ${det.error}`);
      manifest.adapters[id] = { version: det.version };
    }
  }

  const concurrency = opts.concurrency ?? bench.defaults.concurrency;
  const judgeModel = opts.judgeModel ?? bench.defaults.judgeModel;
  const judgeSamples = opts.judgeSamples ?? bench.defaults.judgeSamples;
  const judgeProvider = opts.judgeProvider ?? bench.defaults.judgeProvider;

  let paused = false;
  let pauseReason: string | undefined;
  let roundDone = 0;
  let roundTotal = 0;

  function persistProgress(): RunResults {
    manifest.cells = [...cellStates.values()];
    const costs = records.map((r) => r.agentMeta?.costUsd).filter((v): v is number => v != null);
    manifest.totalCostUsd = costs.length ? costs.reduce((sum, v) => sum + v, 0) : undefined;
    const inputs = records.map((r) => r.agentMeta?.inputTokens).filter((v): v is number => v != null);
    const outputs = records.map((r) => r.agentMeta?.outputTokens).filter((v): v is number => v != null);
    manifest.totalInputTokens = inputs.length ? inputs.reduce((sum, v) => sum + v, 0) : undefined;
    manifest.totalOutputTokens = outputs.length ? outputs.reduce((sum, v) => sum + v, 0) : undefined;
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const results = buildRunResults(manifest, records);
    writeFileSync(join(runDir, 'results.json'), JSON.stringify(results, null, 2));
    return results;
  }

  async function runCell(spec: CellSpec): Promise<void> {
    const relCellDir = join('cells', cellKey(spec), spec.taskId, `rep${spec.rep}`);
    const cellDir = join(runDir, relCellDir);
    const workspaceDir = join(cellDir, 'workspace');
    const task = taskById.get(spec.taskId)!;
    const label = `${cellKey(spec)} × ${spec.taskId} × rep${spec.rep}`;
    const record: CellRecord = {
      cell: { system: spec.system, context: spec.context, model: spec.model, agent: spec.agent },
      taskId: spec.taskId,
      rep: spec.rep,
      status: 'ok',
      artifacts: { dir: relCellDir },
    };

    let usageLimitDetail: string | undefined;

    try {
      const transcriptPath = join(cellDir, 'transcript.jsonl');
      // Timeouts are usually transient (throttling, a slow exploration run),
      // so a timed-out generation gets retried in place before being recorded.
      const maxAttempts = 1 + Math.max(0, bench.defaults.retryTimeouts ?? 1);
      // spec.model keeps the full qualified string ("openai:gpt-5.2") for
      // cellKey/columns/baselines; the adapter itself needs the provider id
      // split out and the bare model name (no prefix) to send to the API.
      const { provider, model: generateModel } = parseModelSpec(spec.model, bench);
      let gen!: Awaited<ReturnType<ReturnType<typeof getAdapter>['generate']>>;
      let costAcc = 0;
      let inputAcc = 0;
      let outputAcc = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (attempt > 1) {
          console.log(`[retry] ${label} → timed out; retrying (attempt ${attempt}/${maxAttempts})`);
        }
        // A resumed or retried cell's workspace may be a stale/partial copy
        // from the previous attempt — always provision into a fresh one.
        rmSync(workspaceDir, { recursive: true, force: true });
        mkdirSync(cellDir, { recursive: true });
        await provisionWorkspace({
          system: spec.system,
          systemCfg: systemsConfig[spec.system],
          context: spec.context,
          destDir: workspaceDir,
        });
        gen = await getAdapter(spec.agent).generate({
          workspaceDir,
          prompt: task.prompt,
          model: generateModel,
          provider,
          appendSystemPrompt: buildSystemPrompt(spec.context),
          addDirs: [],
          timeoutMs: (task.timeoutSec ?? bench.defaults.taskTimeoutSec) * 1_000,
          transcriptPath,
        });
        costAcc += gen.costUsd ?? 0;
        inputAcc += gen.inputTokens ?? 0;
        outputAcc += gen.outputTokens ?? 0;
        if (!gen.timedOut) break;
      }
      // costUsd / tokens are accumulated across attempts — a retried timeout still spent real money.
      record.agentMeta = {
        durationMs: gen.durationMs,
        costUsd: costAcc || undefined,
        numTurns: gen.numTurns,
        inputTokens: inputAcc || undefined,
        outputTokens: outputAcc || undefined,
      };
      record.artifacts!.transcript = join(relCellDir, 'transcript.jsonl');

      if (gen.errorKind === 'usage-limit') {
        usageLimitDetail = `${label}: agent generation hit a usage limit — ${gen.resultText ?? `exit ${gen.exitCode}`}`;
      } else if (gen.timedOut) {
        record.status = 'timeout';
      } else if (!gen.ok) {
        record.status = 'agent-error';
        writeFileSync(join(cellDir, 'agent-error.txt'), gen.resultText ?? `exit ${gen.exitCode}`);
      }

      if (!usageLimitDetail && record.status === 'ok') {
        const collected = await collectArtifacts(workspaceDir, join(cellDir, 'files'));
        writeFileSync(join(cellDir, 'diff.patch'), collected.diffPatch);
        record.artifacts!.diffPatch = join(relCellDir, 'diff.patch');

        const graded = await gradeCell({
          spec,
          task,
          systemsConfig,
          assets: assetsBySystem.get(spec.system)!,
          cellDir,
          diffPatch: collected.diffPatch,
          noJudge: opts.noJudge ?? false,
          judgeModel,
          judgeSamples,
          judgeProvider,
          judgeTimeoutMs: bench.defaults.judgeTimeoutSec * 1_000,
        });
        if (graded.judgeRaw) {
          writeFileSync(join(cellDir, 'judge.json'), JSON.stringify(graded.judgeRaw, null, 2));
          record.artifacts!.judgeJson = join(relCellDir, 'judge.json');
        }
        record.result = composeResult(graded.dimensions);
        writeFileSync(join(cellDir, 'grades.json'), JSON.stringify(record.result, null, 2));
      }
    } catch (err) {
      if (err instanceof UsageLimitError) {
        usageLimitDetail = `${label}: ${err.message}`;
      } else {
        record.status = 'agent-error';
        writeFileSync(join(cellDir, 'agent-error.txt'), String(err instanceof Error ? err.stack : err));
      }
    } finally {
      try {
        await pruneWorkspace(workspaceDir);
      } catch {
        /* workspace may not exist on early failure */
      }

      const key = specId(spec);
      if (usageLimitDetail) {
        cellStates.set(key, { spec, status: 'skipped', skipReason: USAGE_LIMIT_REASON });
        paused = true;
        if (!pauseReason) pauseReason = usageLimitDetail;
        console.log(`[pause] ${label} → usage limit hit; pausing run (this cell will be retried on resume)`);
      } else {
        records.push(record);
        cellStates.set(key, { spec, status: record.status, skipReason: record.skipReason });
        roundDone += 1;
        const score = record.result ? ` overall=${record.result.overall} gate=${record.result.gate}` : '';
        console.log(`[${roundDone}/${roundTotal}] ${label} → ${record.status}${score}`);
      }

      persistProgress();
    }
  }

  // ---------------------------------------------------------------------
  // Drain loop: process pending cells; on a usage-limit pause, either stop
  // (default) or — with --wait — sleep and probe until credits return, then
  // keep draining whatever is still pending.
  // ---------------------------------------------------------------------
  let toRun = initialPending;
  while (toRun.length > 0) {
    paused = false;
    pauseReason = undefined;
    roundTotal = toRun.length;
    roundDone = 0;

    await pool(toRun, concurrency, runCell, () => paused);

    if (!paused) break;
    if (!opts.waitForCredits) break;

    console.log(
      '\n[wait] usage limit hit — waiting for credits to return (probing every 10 min, giving up after 8h)',
    );
    const recovered = await waitForCredits();
    if (!recovered) {
      console.log('[wait] gave up waiting after 8h — finishing paused.');
      break;
    }
    console.log('[wait] credits are back — resuming pending cells.\n');
    toRun = [...cellStates.values()].filter((c) => c.skipReason?.startsWith(PAUSED_PREFIX)).map((c) => c.spec);
  }

  const finishedAt = new Date();
  manifest.finishedAt = finishedAt.toISOString();
  manifest.wallClockMs = finishedAt.getTime() - new Date(manifest.startedAt).getTime();

  if (paused) {
    // Normalize every still-pending entry (including ones that were merely
    // "never started") to the documented resume message.
    for (const [key, entry] of cellStates) {
      if (entry.skipReason?.startsWith(PAUSED_PREFIX)) {
        cellStates.set(key, { ...entry, status: 'skipped', skipReason: USAGE_LIMIT_REASON });
      }
    }
    manifest.paused = true;
    manifest.pausedReason = pauseReason ?? 'usage limit reached';
    const results = persistProgress();
    writeFileSync(join(runDir, 'report.html'), renderReportHtml(results));

    const pendingCount = [...cellStates.values()].filter((c) => c.skipReason?.startsWith(PAUSED_PREFIX)).length;
    const doneCount = cellStates.size - pendingCount;
    console.log(
      `\nrun ${manifest.runId} paused: ${doneCount} cell(s) done, ${pendingCount} pending (usage limit).`,
    );
    console.log(`Resume with: npx tsx src/cli.ts run --resume ${runDir}`);
    return { runDir, results, paused: true };
  }

  manifest.paused = false;
  manifest.pausedReason = undefined;
  const results = persistProgress();
  writeFileSync(join(runDir, 'report.html'), renderReportHtml(results));
  return { runDir, results };
}

/** Re-score an existing run from its stored artifacts (no agent calls unless judging). */
export async function regradeRun(opts: {
  runDir: string;
  judge: boolean; // true → re-run the judge too; false → mechanical only, keep stored judge dims
  judgeModel?: string;
  judgeSamples?: number;
  judgeProvider?: string;
  /** --config override: must match the systems config the run was originally produced against. */
  configPath?: string;
}): Promise<RunResults> {
  const bench = loadBenchConfig();
  const systemsConfigPath = resolveSystemsConfigPath(opts.configPath);
  const systemsConfig = loadSystems(systemsConfigPath);
  const { catalogsDir, tokensDir } = resolveDataDirs(systemsConfigPath);
  const tasks = loadTasks(resolveTasksDir(bench, undefined));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // Absolute: cell paths derived from runDir feed execFile cwd/binary paths,
  // which must not depend on the caller's working directory.
  opts = { ...opts, runDir: resolve(opts.runDir) };
  const resultsPath = join(opts.runDir, 'results.json');
  const prior = JSON.parse(readFileSync(resultsPath, 'utf8')) as RunResults;
  const assetsBySystem = new Map<SystemId, SystemAssets>();

  for (const record of prior.records) {
    if (record.status !== 'ok' || !record.artifacts) continue;
    const spec: CellSpec = { ...record.cell, taskId: record.taskId, rep: record.rep };
    const task = taskById.get(record.taskId);
    if (!task) continue;
    if (!assetsBySystem.has(spec.system)) {
      assetsBySystem.set(spec.system, loadSystemAssets(spec.system, catalogsDir, tokensDir));
    }
    const cellDir = join(opts.runDir, record.artifacts.dir);
    const diffPatch = record.artifacts.diffPatch
      ? readFileSync(join(opts.runDir, record.artifacts.diffPatch), 'utf8')
      : '';

    const graded = await gradeCell({
      spec,
      task,
      systemsConfig,
      assets: assetsBySystem.get(spec.system)!,
      cellDir,
      diffPatch,
      noJudge: !opts.judge,
      judgeModel: opts.judgeModel ?? bench.defaults.judgeModel,
      judgeSamples: opts.judgeSamples ?? bench.defaults.judgeSamples,
      judgeProvider: opts.judgeProvider ?? bench.defaults.judgeProvider,
      judgeTimeoutMs: bench.defaults.judgeTimeoutSec * 1_000,
    });
    let dimensions = graded.dimensions;
    if (!opts.judge && record.result?.dimensions['judgment']) {
      dimensions = [...dimensions, record.result.dimensions['judgment']];
    }
    if (graded.judgeRaw) {
      writeFileSync(join(cellDir, 'judge.json'), JSON.stringify(graded.judgeRaw, null, 2));
    }
    record.result = composeResult(dimensions);
    writeFileSync(join(cellDir, 'grades.json'), JSON.stringify(record.result, null, 2));
  }

  const results = buildRunResults(prior.manifest, prior.records);
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  writeFileSync(join(opts.runDir, 'report.html'), renderReportHtml(results));
  return results;
}

/** Most recent run directory, by mtime. */
export function latestRunDir(): string | undefined {
  if (!existsSync(paths.runsDir)) return undefined;
  const dirs = readdirSync(paths.runsDir)
    .map((name) => join(paths.runsDir, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'manifest.json')));
  dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0];
}
