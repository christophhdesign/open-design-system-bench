import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatBytes, parseAge, pruneRuns } from './prune.ts';

function writeRun(
  runsDir: string,
  name: string,
  opts: { finishedAt?: string; startedAt?: string; workspaceBytes?: number },
): string {
  const dir = join(runsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      runId: name,
      startedAt: opts.startedAt ?? '2026-08-01T00:00:00.000Z',
      finishedAt: opts.finishedAt,
    }),
  );
  writeFileSync(join(dir, 'results.json'), '{}');
  writeFileSync(join(dir, 'report.html'), '<html></html>');
  const ws = join(dir, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'workspace');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'blob.bin'), Buffer.alloc(opts.workspaceBytes ?? 1024, 1));
  writeFileSync(join(dir, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'grades.json'), '{}');
  const files = join(dir, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'files');
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, 'src.tsx'), 'export const x = 1;\n');
  return dir;
}

test('parseAge accepts day/hour/week specs', () => {
  assert.equal(parseAge('7d'), 7 * 86_400_000);
  assert.equal(parseAge('24h'), 24 * 3_600_000);
  assert.equal(parseAge('2w'), 14 * 86_400_000);
  assert.throws(() => parseAge('nope'));
});

test('formatBytes uses KB/MB', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.match(formatBytes(10_000), /KB/);
  assert.match(formatBytes(5_000_000), /MB/);
});

test('pruneRuns removes workspaces from old finished runs and keeps report files', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'agent-evals-prune-'));
  try {
    const old = writeRun(runsDir, 'old-run', { finishedAt: '2026-08-01T00:00:00.000Z' });
    const kept = writeRun(runsDir, 'new-run', { finishedAt: '2026-08-20T00:00:00.000Z' });
    const live = writeRun(runsDir, 'live-run', {});

    const result = pruneRuns({
      runsDir,
      keep: 1,
      now: Date.parse('2026-08-25T00:00:00.000Z'),
    });

    assert.ok(result.runDirs.some((d) => d.endsWith('old-run')));
    assert.ok(!existsSync(join(old, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'workspace')));
    assert.ok(existsSync(join(old, 'results.json')));
    assert.ok(existsSync(join(old, 'report.html')));
    assert.ok(existsSync(join(old, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'grades.json')));
    assert.ok(existsSync(join(kept, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'workspace')));
    assert.ok(existsSync(join(live, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'workspace')));
    assert.ok(result.bytes > 0);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('pruneRuns --dry-run does not delete', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'agent-evals-prune-dry-'));
  try {
    const old = writeRun(runsDir, 'old-run', { finishedAt: '2026-08-01T00:00:00.000Z' });
    pruneRuns({ runsDir, keep: 0, dryRun: true, now: Date.parse('2026-08-25T00:00:00.000Z') });
    assert.ok(existsSync(join(old, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'workspace')));
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('pruneRuns --older-than skips recent finished runs', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'agent-evals-prune-age-'));
  try {
    const recent = writeRun(runsDir, 'recent-run', { finishedAt: '2026-08-24T00:00:00.000Z' });
    const result = pruneRuns({
      runsDir,
      keep: 0,
      olderThanMs: parseAge('7d'),
      now: Date.parse('2026-08-25T00:00:00.000Z'),
    });
    assert.equal(result.runDirs.length, 0);
    assert.ok(existsSync(join(recent, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'workspace')));
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('pruneRuns skips a finished run that still has timeout cells', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'agent-evals-prune-retry-'));
  try {
    const dir = writeRun(runsDir, 'retry-run', { finishedAt: '2026-08-01T00:00:00.000Z' });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        runId: 'retry-run',
        startedAt: '2026-08-01T00:00:00.000Z',
        finishedAt: '2026-08-01T01:00:00.000Z',
        cells: [{ spec: {}, status: 'timeout' }, { spec: {}, status: 'ok' }],
      }),
    );
    const result = pruneRuns({
      runsDir,
      keep: 0,
      now: Date.parse('2026-08-25T00:00:00.000Z'),
    });
    assert.equal(result.runDirs.length, 0);
    assert.ok(result.skipped.some((s) => s.reason.includes('timeout/error')));
    assert.ok(existsSync(join(dir, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'workspace')));
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});

test('pruneRuns --deep also removes files/', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'agent-evals-prune-deep-'));
  try {
    const old = writeRun(runsDir, 'old-run', { finishedAt: '2026-08-01T00:00:00.000Z' });
    pruneRuns({ runsDir, keep: 0, deep: true, now: Date.parse('2026-08-25T00:00:00.000Z') });
    assert.ok(!existsSync(join(old, 'cells', 'systemB_bare_gateway:x', 'task-a', 'rep1', 'files')));
    assert.ok(existsSync(join(old, 'results.json')));
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
