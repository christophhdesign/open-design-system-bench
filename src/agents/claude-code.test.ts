import assert from 'node:assert/strict';
import { homedir } from 'node:os';
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
