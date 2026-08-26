// Design-systemBgnosticism smoke test: a synthetic SystemsConfig with two
// arbitrary, non-the example system system ids proves the harness has no hardcoded
// assumptions about "systemB"/"systemA" anywhere in the matrix-expansion or
// task-applicability path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { BenchConfig, BenchProfile, SystemCatalog, Task } from '../types.ts';
import { cellKey } from '../types.ts';
import { expandMatrix } from './matrix.ts';
import { validateTaskSuite } from '../tasks/load.ts';

// ---------------------------------------------------------------------------
// A synthetic two-system config: ids chosen to be as un-the example system as possible.
// ---------------------------------------------------------------------------

const bench: BenchConfig = {
  profiles: {},
  defaults: {
    agent: 'claude-code',
    generatorModel: 'sonnet',
    judgeModel: 'haiku',
    taskTimeoutSec: 600,
    judgeTimeoutSec: 120,
    concurrency: 2,
    judgeSamples: 1,
  },
  ci: { maxScoreDrop: 5, maxErroredCellRatio: 0.2 },
};

const profile: BenchProfile = {
  systems: ['acme', 'zephyr'],
  contexts: ['bare', 'agents-md'],
  models: ['sonnet'],
  tasks: '*',
  reps: 1,
};

const universalTask: Task = {
  id: 'universal-task',
  title: 'Applies to every configured system',
  // `systems` intentionally omitted — absent means "every configured system".
  prompt: 'Do the thing, wherever it runs.',
  rubrics: [{ id: 'r1', text: 'Does the thing', weight: 1, critical: true }],
};

const acmeOnlyTask: Task = {
  id: 'acme-only-task',
  title: 'Applies only to acme',
  systems: ['acme'],
  prompt: 'Do the acme-specific thing.',
  rubrics: [{ id: 'r1', text: 'Does the acme thing', weight: 1 }],
};

const tasks: Task[] = [universalTask, acmeOnlyTask];

// ---------------------------------------------------------------------------
// expandMatrix: arbitrary system ids flow straight through, no special-casing.
// ---------------------------------------------------------------------------

test('expandMatrix produces cells keyed by arbitrary system ids (acme/zephyr), not systemB/systemA', () => {
  const { cells } = expandMatrix(profile, bench, tasks);

  const systemsSeen = new Set(cells.map((c) => c.system));
  assert.deepEqual([...systemsSeen].sort(), ['acme', 'zephyr']);

  // cellKey embeds the system id verbatim.
  const acmeCell = cells.find((c) => c.system === 'acme' && c.taskId === 'universal-task' && c.context === 'bare')!;
  assert.equal(cellKey(acmeCell), 'acme_bare_sonnet');

  const zephyrCell = cells.find(
    (c) => c.system === 'zephyr' && c.taskId === 'universal-task' && c.context === 'bare',
  )!;
  assert.equal(cellKey(zephyrCell), 'zephyr_bare_sonnet');
});

test('a task with systems absent applies to every configured system', () => {
  const { cells } = expandMatrix(profile, bench, tasks);
  const universalCells = cells.filter((c) => c.taskId === 'universal-task');
  const systemsForUniversal = new Set(universalCells.map((c) => c.system));
  assert.deepEqual([...systemsForUniversal].sort(), ['acme', 'zephyr']);
});

test('a task with systems: ["acme"] runs on acme and is skipped on zephyr with a reason', () => {
  const { cells, skipped } = expandMatrix(profile, bench, tasks);

  const acmeOnlyCells = cells.filter((c) => c.taskId === 'acme-only-task');
  assert.ok(acmeOnlyCells.every((c) => c.system === 'acme'));
  assert.ok(acmeOnlyCells.length > 0);

  const zephyrSkip = skipped.find((s) => s.spec.taskId === 'acme-only-task' && s.spec.system === 'zephyr');
  assert.ok(zephyrSkip, 'expected acme-only-task to be skipped for zephyr');
  assert.match(zephyrSkip!.reason, /not applicable to system "zephyr"/);
});

// ---------------------------------------------------------------------------
// validateTaskSuite: missing hiddenExpectations warns, never errors.
// ---------------------------------------------------------------------------

const acmeCatalog: SystemCatalog = {
  system: 'acme',
  generatedAt: new Date().toISOString(),
  source: { root: '/fake/acme', commit: 'deadbeef', srcHash: 'hash' },
  components: [{ dir: 'button', exports: [{ displayName: 'Button', description: '', props: [] }] }],
  allExports: ['Button'],
  allPropsByExport: { Button: ['variant'] },
};

const zephyrCatalog: SystemCatalog = {
  system: 'zephyr',
  generatedAt: new Date().toISOString(),
  source: { root: '/fake/zephyr', commit: 'deadbeef', srcHash: 'hash' },
  components: [{ dir: 'button', exports: [{ displayName: 'Button', description: '', props: [] }] }],
  allExports: ['Button'],
  allPropsByExport: { Button: ['variant'] },
};

test('validateTaskSuite warns (not errors) on a task with no hiddenExpectations', () => {
  const { errors, warnings } = validateTaskSuite(tasks, { acme: acmeCatalog, zephyr: zephyrCatalog });

  assert.deepEqual(errors, []);
  assert.ok(
    warnings.some((w) => w.includes('universal-task') && w.includes('hiddenExpectations')),
    `expected a hiddenExpectations warning for universal-task, got: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    warnings.some((w) => w.includes('acme-only-task') && w.includes('hiddenExpectations')),
    `expected a hiddenExpectations warning for acme-only-task, got: ${JSON.stringify(warnings)}`,
  );
});

test('validateTaskSuite errors on a real hiddenExpectations symbol mismatch, on any system id', () => {
  const badTask: Task = {
    id: 'bad-task',
    title: 'References a symbol that does not exist',
    systems: ['acme'],
    prompt: 'Build a thing.',
    hiddenExpectations: { componentsAnyOf: { acme: ['NotARealComponent'] } },
    rubrics: [{ id: 'r1', text: 'x', weight: 1 }],
  };
  const { errors } = validateTaskSuite([badTask], { acme: acmeCatalog });
  assert.ok(errors.some((e) => e.includes('NotARealComponent')));
});
