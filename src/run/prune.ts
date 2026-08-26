// Manual disk cleanup for finished runs. Never called from the runner —
// resume / --retry-errored always provision a fresh workspace, but we still
// refuse runs that still have pending, timeout, or agent-error cells so you
// can retry those first. results.json / report.html / grades / judge / diffs
// are never deleted.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { paths } from '../config.ts';

const KEEP_ALWAYS = new Set([
  'manifest.json',
  'results.json',
  'report.html',
  'grades.json',
  'judge.json',
  'diff.patch',
  'transcript.jsonl',
  'transcript.json',
  'agent-error.txt',
]);

export interface PruneOptions {
  runsDir?: string;
  /** Only this run directory (absolute or relative). Ignores --keep. */
  runDir?: string;
  /** Drop workspaces only from runs whose finishedAt is older than this. */
  olderThanMs?: number;
  /** Newest finished runs to leave untouched. Default 1. Ignored when runDir is set. */
  keep?: number;
  /** Also delete per-cell `files/` copies (breaks `grade --run`). */
  deep?: boolean;
  dryRun?: boolean;
  /** Allow pruning a run that has not finished, or still has retryable cells. */
  force?: boolean;
  now?: number;
}

export interface PruneResult {
  runDirs: string[];
  skipped: Array<{ dir: string; reason: string }>;
  removed: string[];
  bytes: number;
  dryRun: boolean;
}

export function parseAge(spec: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d|w)?$/i.exec(spec.trim());
  if (!m) throw new Error(`invalid --older-than "${spec}" (use e.g. 7d, 24h, 2w)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'd').toLowerCase();
  const ms: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
  };
  return n * (ms[unit] ?? 86_400_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function pathSize(p: string): number {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink() || st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let sum = 0;
  for (const name of readdirSync(p)) {
    sum += pathSize(join(p, name));
  }
  return sum;
}

function findNamedDirs(root: string, name: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === name) out.push(p);
      else walk(p);
    }
  };
  walk(root);
  return out;
}

const RETRYABLE_STATUS = new Set(['timeout', 'agent-error']);
const PAUSED_PREFIX = 'paused:';

interface RunInfo {
  dir: string;
  finishedAt?: number;
  startedAt?: number;
  retryable: number;
}

function readRunInfo(dir: string): RunInfo {
  const info: RunInfo = { dir, retryable: 0 };
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        finishedAt?: string;
        startedAt?: string;
        cells?: Array<{ status?: string; skipReason?: string }>;
      };
      if (m.finishedAt) info.finishedAt = Date.parse(m.finishedAt);
      if (m.startedAt) info.startedAt = Date.parse(m.startedAt);
      for (const cell of m.cells ?? []) {
        if (RETRYABLE_STATUS.has(cell.status ?? '')) info.retryable += 1;
        else if (cell.skipReason?.startsWith(PAUSED_PREFIX)) info.retryable += 1;
      }
    } catch {
      /* treat as unfinished / unreadable */
    }
  }
  const resultsPath = join(dir, 'results.json');
  if (info.retryable === 0 && existsSync(resultsPath)) {
    try {
      const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
        records?: Array<{ status?: string; skipReason?: string }>;
      };
      for (const rec of results.records ?? []) {
        if (RETRYABLE_STATUS.has(rec.status ?? '')) info.retryable += 1;
        else if (rec.skipReason?.startsWith(PAUSED_PREFIX)) info.retryable += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return info;
}

function listRunDirs(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .map((name) => join(runsDir, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(join(p, 'manifest.json'));
      } catch {
        return false;
      }
    });
}

function targetsFor(runDir: string, deep: boolean): string[] {
  const cells = join(runDir, 'cells');
  const names = deep ? ['workspace', 'files'] : ['workspace'];
  return names.flatMap((name) => findNamedDirs(cells, name));
}

export function pruneRuns(opts: PruneOptions = {}): PruneResult {
  const runsDir = opts.runsDir ?? paths.runsDir;
  const now = opts.now ?? Date.now();
  const keep = opts.runDir != null ? 0 : Math.max(0, opts.keep ?? 1);
  const dryRun = opts.dryRun === true;
  const deep = opts.deep === true;

  const skipped: PruneResult['skipped'] = [];
  let candidates: RunInfo[];

  if (opts.runDir) {
    candidates = [readRunInfo(opts.runDir)];
  } else {
    candidates = listRunDirs(runsDir).map(readRunInfo);
    candidates.sort((a, b) => (b.finishedAt ?? b.startedAt ?? 0) - (a.finishedAt ?? a.startedAt ?? 0));
  }

  const selected: RunInfo[] = [];
  let kept = 0;
  for (const run of candidates) {
    if (!existsSync(run.dir)) {
      skipped.push({ dir: run.dir, reason: 'not found' });
      continue;
    }
    if (run.finishedAt == null && !opts.force) {
      skipped.push({ dir: run.dir, reason: 'still running (no finishedAt)' });
      continue;
    }
    if (run.retryable > 0 && !opts.force) {
      skipped.push({
        dir: run.dir,
        reason: `${run.retryable} pending/timeout/error cell(s) — resume or --retry-errored first, or pass --force`,
      });
      continue;
    }
    if (opts.olderThanMs != null && run.finishedAt != null && now - run.finishedAt < opts.olderThanMs) {
      skipped.push({ dir: run.dir, reason: 'newer than --older-than' });
      continue;
    }
    if (kept < keep) {
      kept += 1;
      skipped.push({ dir: run.dir, reason: `kept as one of the ${keep} newest` });
      continue;
    }
    selected.push(run);
  }

  const removed: string[] = [];
  let bytes = 0;
  for (const run of selected) {
    for (const target of targetsFor(run.dir, deep)) {
      if (KEEP_ALWAYS.has(target.split(/[/\\]/).pop() ?? '')) continue;
      bytes += pathSize(target);
      removed.push(relative(runsDir, target) || target);
      if (!dryRun) rmSync(target, { recursive: true, force: true });
    }
  }

  return {
    runDirs: selected.map((r) => r.dir),
    skipped,
    removed,
    bytes,
    dryRun,
  };
}
