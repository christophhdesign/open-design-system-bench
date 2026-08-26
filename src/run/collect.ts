// Collects the grading artifacts out of a provisioned workspace after an
// agent has run in it: a unified diff against the baseline commit (see
// fixture.ts#provisionWorkspace), the list of changed files, and copies of
// the changed source files for downstream mechanical checks.

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const COLLECTED_EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.jsx', '.js']);

export interface CollectResult {
  diffPatch: string;
  changedFiles: string[];
}

async function git(workspaceDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspaceDir,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export async function collectArtifacts(
  workspaceDir: string,
  filesOutDir: string,
): Promise<CollectResult> {
  await git(workspaceDir, ['add', '-A']);

  const diffPatch = await git(workspaceDir, ['diff', '--cached']);
  const nameOnly = await git(workspaceDir, ['diff', '--cached', '--name-only']);
  const changedFiles = nameOnly
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const relPath of changedFiles) {
    if (!COLLECTED_EXTENSIONS.has(extname(relPath))) continue;

    const srcPath = join(workspaceDir, relPath);
    if (!existsSync(srcPath)) continue; // deleted file — nothing to copy

    const destPath = join(filesOutDir, relPath);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
  }

  return { diffPatch, changedFiles };
}
