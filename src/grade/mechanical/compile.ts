// Dimension: compile (weight .10)
// Runs `tsc --noEmit` against the generated workspace. This is a hard gate:
// code that doesn't typecheck can't have done what the task asked, no matter
// how good it looks statically.
//
// In source mode the program also contains the system's own source, compiled
// under the fixture's compiler options rather than the system's (an older lib,
// Vite's CSS-module typing). Errors inside those files are setup, not the
// agent's: they are reported and never gate. Only errors in the workspace,
// which is all the agent can touch, fail the dimension.

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { PKG_ROOT } from '../../config.ts';
import type { DimensionResult, Diff } from '../../types.ts';
import type { GradeContext } from '../context.ts';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 120_000;
const MAX_ERROR_LINES = 20;

function resolveTsc(workspaceDir: string): string {
  const workspaceTsc = join(workspaceDir, 'node_modules', '.bin', 'tsc');
  if (existsSync(workspaceTsc)) return workspaceTsc;
  return join(PKG_ROOT, 'node_modules', '.bin', 'tsc');
}

const ERROR_START = /^(.+?)\(\d+,\d+\): error TS\d+:/;

/**
 * Splits tsc output into errors in the workspace (the agent's) and errors in
 * files outside it (the system's own source: setup). A continuation line
 * belongs to the error above it; an error with no file is setup.
 */
export function attributeTscErrors(output: string, workspaceDir: string): { agent: string[]; setup: string[] } {
  // tsc prints paths relative to its real cwd, so a workspace under a symlink
  // (macOS's /tmp, /var) has to be matched under both of its names.
  const bases = [resolve(workspaceDir)];
  try {
    bases.push(realpathSync(workspaceDir));
  } catch {
    /* not on disk: the given path is all there is */
  }
  const inWorkspace = (file: string) => bases.some((b) => bases.some((r) => resolve(b, file).startsWith(r + sep)));
  const agent: string[] = [];
  const setup: string[] = [];
  let current: string[] | undefined;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const m = ERROR_START.exec(line);
    if (m) {
      current = inWorkspace(m[1]!) ? agent : setup;
      current.push(line);
    } else if (/^\s/.test(line) && current) {
      current[current.length - 1] += `\n${line}`;
    } else {
      (current = setup).push(line);
    }
  }
  return { agent, setup };
}

export async function gradeCompile(ctx: GradeContext): Promise<DimensionResult> {
  const tscBin = resolveTsc(ctx.workspaceDir);
  const tsconfigPath = join(ctx.workspaceDir, 'tsconfig.json');

  try {
    await execFileAsync(tscBin, ['--noEmit', '-p', tsconfigPath], {
      cwd: ctx.workspaceDir,
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { dimension: 'compile', score: 100, gate: 'pass', diffs: [] };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; message?: string };
    const output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    const lines =
      output.length > 0
        ? output.split('\n').filter((l) => l.trim().length > 0)
        : [`tsc failed with no output${e.message ? ` (${e.message})` : ''}`];
    const timedOut = e.killed === true || e.signal === 'SIGTERM';
    if (timedOut) {
      return { dimension: 'compile', score: 0, gate: 'fail', diffs: [{ dimension: 'compile', message: 'tsc timed out after 120s' }] };
    }

    // Nothing tsc could place in a file (a missing tsconfig, a crash): the
    // program never ran, so nothing was measured and nothing is attributable.
    if (!lines.some((l) => ERROR_START.test(l))) {
      return { dimension: 'compile', score: 0, gate: 'fail', diffs: lines.slice(0, MAX_ERROR_LINES).map((message) => ({ dimension: 'compile', message })) };
    }
    const { agent, setup } = attributeTscErrors(lines.join('\n'), ctx.workspaceDir);
    const setupDiff: Diff[] = setup.length
      ? [{
          dimension: 'compile',
          message: `setup, not the agent: ${setup.length} type error(s) outside the workspace, in the system's own source under the fixture's compiler options. First: ${setup[0]!.split('\n')[0]}`,
          fix: "these never gate; they mean the fixture compiles this system's source differently from the system's own build",
        }]
      : [];
    if (agent.length === 0) {
      return { dimension: 'compile', score: 100, gate: 'pass', diffs: setupDiff };
    }
    const diffs: Diff[] = agent.slice(0, MAX_ERROR_LINES).map((line) => ({ dimension: 'compile', message: line }));
    return { dimension: 'compile', score: 0, gate: 'fail', diffs: [...diffs, ...setupDiff] };
  }
}
