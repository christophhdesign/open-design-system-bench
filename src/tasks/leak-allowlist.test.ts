import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTaskSuite } from './load.ts';
import { parseTask } from './schema.ts';
import { proposeLeakAllowlist } from '../init/wizard.ts';
import type { SystemCatalog, SystemConfig } from '../types.ts';

const task = (id: string, prompt: string) =>
  parseTask(`id: ${id}\ntitle: t\nprompt: ${prompt}\nrubrics:\n  - id: r\n    text: r\n    weight: 1\n    critical: true\n`, `${id}.yaml`);

const TASKS = [
  task('empty-state', 'Show an empty state for each device. Plan For later.'),
  task('saved', 'Tell the user the change was saved, with a notification and a Text label.'),
];

const catalog = (system: string, allExports: string[]): SystemCatalog => ({
  system,
  generatedAt: '',
  source: { root: '', commit: '', srcHash: '' },
  components: [],
  allExports,
  allPropsByExport: {},
});

const cfg = (leakAllowlist?: string[]) => ({ leakAllowlist }) as SystemConfig;

test('a system allowlist clears its own ordinary-word leaks and nobody else\'s', () => {
  const catalogs = { chakra: catalog('chakra', ['For', 'Show', 'Button']), other: catalog('other', ['Show']) };
  const before = validateTaskSuite(TASKS, catalogs);
  assert.equal(before.errors.length, 3); // chakra For + Show, other Show
  assert.ok(before.errors.every((e) => /add "\w+" to \w+'s "leakAllowlist"/.test(e)), 'each failure names the fix');

  const after = validateTaskSuite(TASKS, catalogs, { chakra: cfg(['For', 'show']) });
  assert.deepEqual(after.errors.map((e) => e.match(/leaks (\w+) component "(\w+)"/)!.slice(1).join(':')), ['other:Show']);
});

test('a real component name in a prompt still fails', () => {
  const leaky = [task('pw', 'Use a PasswordInput so users can check what they typed.')];
  const res = validateTaskSuite(leaky, { mantine: catalog('mantine', ['PasswordInput', 'Notification']) }, { mantine: cfg(['Notification']) });
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0]!, /"PasswordInput"/);
});

test('init proposes the leaked words with the tasks that use them, minus what is already allowed', () => {
  const exports = ['For', 'Show', 'Notification', 'Text', 'Button'];
  assert.deepEqual(proposeLeakAllowlist(TASKS, exports), [
    { symbol: 'For', taskIds: ['empty-state'] },
    { symbol: 'Notification', taskIds: ['saved'] },
    { symbol: 'Show', taskIds: ['empty-state'] },
  ]); // Text is on the global list
  assert.deepEqual(proposeLeakAllowlist(TASKS, exports, cfg(['For', 'Show'])).map((p) => p.symbol), ['Notification']);
});
