import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { test } from 'node:test';

import { isolationSettings } from './claude-code.ts';

test('isolationSettings excludes every CLAUDE.md outside the workspace and none inside it', () => {
  const ws = '/repo/runs/r1/cells/c/t/rep1/workspace';
  const { autoMemoryEnabled, claudeMdExcludes } = isolationSettings(ws);
  const excluded = (p: string) => claudeMdExcludes.some((glob) => matchesGlob(p, glob));

  assert.equal(autoMemoryEnabled, false);
  const userClaudeMd = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'CLAUDE.md');
  for (const p of ['/repo/CLAUDE.md', '/repo/AGENTS.md', '/repo/runs/CLAUDE.local.md', '/repo/.claude/rules/x.md', '/CLAUDE.md', userClaudeMd]) {
    assert.ok(excluded(p), `${p} should be excluded`);
  }
  for (const p of [`${ws}/CLAUDE.md`, `${ws}/.claude/skills/s/SKILL.md`, `${ws}/docs/guide.md`]) {
    assert.ok(!excluded(p), `${p} should stay visible`);
  }
});

test('isolationSettings also excludes ancestors reached through a symlink', () => {
  const real = mkdtempSync(join(tmpdir(), 'odsb-real-'));
  const link = `${real}-link`;
  try {
    const ws = join(real, 'runs', 'r1', 'workspace');
    mkdirSync(ws, { recursive: true });
    symlinkSync(join(real, 'runs'), link);
    const viaLink = join(link, 'r1', 'workspace');
    const { claudeMdExcludes } = isolationSettings(viaLink);
    const excluded = (p: string) => claudeMdExcludes.some((glob) => matchesGlob(p, glob));
    // The walk Claude Code does starts from the real path.
    assert.ok(excluded(join(realpathSync(real), 'CLAUDE.md')), 'the real ancestor is excluded');
    assert.ok(excluded(join(link, 'CLAUDE.md')), 'the linked ancestor is excluded');
    assert.ok(!excluded(join(realpathSync(ws), 'CLAUDE.md')), 'the workspace stays visible');
  } finally {
    rmSync(link, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
});
