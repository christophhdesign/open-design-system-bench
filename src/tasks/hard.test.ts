// tasks/hard/ is loaded as part of the suite but left out of a profile's "*"
// unless --hard (or the profile's `hard`) asks for it.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { expandMatrix } from '../run/matrix.ts';
import type { BenchConfig, BenchProfile } from '../types.ts';
import { loadTasks } from './load.ts';

const yaml = (id: string) =>
  `id: ${id}\ntitle: ${id}\nprompt: do the thing\nrubrics:\n  - id: r\n    text: it works\n    weight: 1\n`;

test('hard tasks load with hard: true and join a "*" matrix only when asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-hard-'));
  mkdirSync(join(dir, 'hard'));
  writeFileSync(join(dir, 'starter.yaml'), yaml('starter'));
  writeFileSync(join(dir, 'hard', 'tough.yaml'), yaml('tough'));

  const tasks = loadTasks(dir);
  assert.deepEqual(
    tasks.map((t) => [t.id, t.hard ?? false]),
    [
      ['starter', false],
      ['tough', true],
    ],
  );

  const bench = { profiles: {}, defaults: {} } as unknown as BenchConfig;
  const profile: BenchProfile = { systems: ['s'], contexts: ['bare'], models: ['m'], tasks: '*', reps: 1 };
  const ids = (cells: { taskId: string }[]) => cells.map((c) => c.taskId).sort();

  assert.deepEqual(ids(expandMatrix(profile, bench, tasks).cells), ['starter']);
  assert.deepEqual(ids(expandMatrix(profile, bench, tasks, { hard: true }).cells), ['starter', 'tough']);
  assert.deepEqual(ids(expandMatrix({ ...profile, hard: true }, bench, tasks).cells), ['starter', 'tough']);
  // An explicit id list is taken as given, hard or not.
  assert.deepEqual(ids(expandMatrix(profile, bench, tasks, { tasks: ['tough'] }).cells), ['tough']);
});
