import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contradictedClaims, scoreJudgeOutput } from './judge.ts';
import { withheldRubrics } from '../tasks/affordances.ts';
import { parseTask } from '../tasks/schema.ts';
import { validateTaskSuite } from '../tasks/load.ts';
import type { JudgeOutput, SystemCatalog, Task } from '../types.ts';

const TASK: Task = parseTask(
  `id: pw
title: Reveal password
prompt: Let users check what they typed.
rubrics:
  - id: builtin-affordance
    text: Builds on the system's input component
    weight: 0.5
    critical: true
    presumes: text-input
  - id: accessible-toggle
    text: Toggle name reflects state
    weight: 0.3
  - id: no-leak
    text: Value never echoed
    weight: 0.2
`,
  'pw.yaml',
);

function catalog(system: string, allExports: string[]): SystemCatalog {
  return {
    system,
    generatedAt: '',
    source: { root: '', commit: '', srcHash: '' },
    components: [],
    allExports,
    allPropsByExport: {},
  };
}

const NO_INPUT = catalog('appkit', ['Button', 'IconButton', 'SearchInput', 'SearchInputProps']);
const WITH_INPUT = catalog('mantine', ['Button', 'Input', 'PasswordInput']);

const DIFF = [
  '+++ b/src/task/index.tsx',
  "+import { useState } from 'react';",
  "+import { Button, Icon, IconButton, Stack, Text } from '@aurora-appkit/components';",
  '+export function Login() {',
  '+  return <Stack><input type="password" /><IconButton icon="eye" /></Stack>;',
  '+}',
].join('\n');

const OUTPUT: JudgeOutput = {
  verdicts: [
    { rubricId: 'builtin-affordance', pass: false, score: 0, reasoning: 'hand-rolls a bare <input>' },
    { rubricId: 'accessible-toggle', pass: true, score: 1, reasoning: 'label flips' },
    { rubricId: 'no-leak', pass: true, score: 1, reasoning: 'never logged' },
  ],
  overallNotes: '',
};

test('parseTask reads presumes', () => {
  assert.equal(TASK.rubrics[0]!.presumes, 'text-input');
  assert.equal(TASK.rubrics[1]!.presumes, undefined);
});

test('a rubric is withheld only when the catalog exports none of the affordance names', () => {
  assert.deepEqual([...withheldRubrics(TASK, NO_INPUT).keys()], ['builtin-affordance']);
  assert.equal(withheldRubrics(TASK, WITH_INPUT).size, 0);
  // A near-miss name does not count: SearchInput is not a text input.
  assert.match(withheldRubrics(TASK, NO_INPUT).get('builtin-affordance')!, /exports none of Input, TextInput/);
  // A system that names it differently declares the name instead.
  const entry = catalog('appkit', ['TextEntry']);
  assert.equal(withheldRubrics(TASK, entry, { affordances: { 'text-input': ['TextEntry'] } }).size, 0);
});

test('a withheld rubric redistributes its weight and never gates', () => {
  const graded = scoreJudgeOutput({ task: TASK, catalog: WITH_INPUT, output: OUTPUT, diffPatch: DIFF })!;
  assert.equal(graded.score, 50);
  assert.equal(graded.gate, 'review'); // critical rubric failed where it can be graded

  const withheld = scoreJudgeOutput({ task: TASK, catalog: NO_INPUT, output: OUTPUT, diffPatch: DIFF })!;
  assert.equal(withheld.score, 100); // (0.3 * 1 + 0.2 * 1) / 0.5
  assert.equal(withheld.gate, 'pass');
  const note = withheld.diffs.find((d) => d.message.startsWith('builtin-affordance withheld'));
  assert.ok(note, 'report.html shows why through the judgment notes');
  assert.ok(note!.fix?.includes('affordances'));
});

test('a task whose every rubric is withheld has no judgment dimension', () => {
  const only: Task = { ...TASK, rubrics: [{ ...TASK.rubrics[0]!, weight: 1 }] };
  assert.equal(scoreJudgeOutput({ task: only, catalog: NO_INPUT, output: OUTPUT, diffPatch: DIFF }), undefined);
});

test('validate-tasks lists withheld rubrics and rejects unknown affordances', () => {
  const res = validateTaskSuite([TASK], { appkit: NO_INPUT, mantine: WITH_INPUT });
  assert.equal(res.errors.length, 0);
  assert.ok(res.warnings.some((w) => /"builtin-affordance" is withheld for appkit/.test(w)));
  assert.ok(!res.warnings.some((w) => /withheld for mantine/.test(w)));

  const typo: Task = { ...TASK, rubrics: [{ ...TASK.rubrics[0]!, presumes: 'text-inptu' }, ...TASK.rubrics.slice(1)] };
  const bad = validateTaskSuite([typo], { mantine: WITH_INPUT });
  assert.ok(bad.errors.some((e) => /unknown affordance "text-inptu"/.test(e)));
  // ...unless a configured system declares it.
  const declared = validateTaskSuite([typo], { mantine: WITH_INPUT }, {
    mantine: { affordances: { 'text-inptu': ['Input'] } } as never,
  });
  assert.equal(declared.errors.length, 0);
});

// --- A2: the judge's claims against the diff ---------------------------------

const verdict = (reasoning: string) => ({ verdicts: [{ rubricId: 'r', pass: false, score: 0, reasoning }], overallNotes: '' });
const APPKIT = catalog('appkit', ['Button', 'Icon', 'IconButton', 'Stack', 'Text', 'Modal', 'ModalContent', 'Toggle']);

test('the invented AppKit import is flagged', () => {
  // Verbatim from the Opus 5.5 field-test verdict (2026-09-22).
  const claims = contradictedClaims(
    verdict("The code hand-rolls a bare <input> element with custom styling and bolts on a separate <IconButton> for visibility control. The design system's Input component is imported but never used."),
    DIFF,
    APPKIT,
  );
  assert.deepEqual(claims.map((c) => [c.name, c.kind]), [['Input', 'import']]);
});

test('claims the diff supports, negated claims and non-catalog names are not flagged', () => {
  const none = (reasoning: string) => assert.deepEqual(contradictedClaims(verdict(reasoning), DIFF, APPKIT), [], reasoning);
  none('Code imports and uses Button, IconButton and Stack from the design system.');
  none('Uses `<IconButton>` with an aria-label that flips with state.');
  none('Instead of using the system Toggle, it renders a bare checkbox.');
  none('The code does not import Modal at all, so the confirmation is hand-rolled.');
  none('Uses React state to track visibility.'); // React is not a catalog component
});

test('a listed component the diff never brings in is flagged, per name', () => {
  const claims = contradictedClaims(verdict('Code imports and uses Modal, ModalContent and Button for the dialog.'), DIFF, APPKIT);
  assert.deepEqual(claims.map((c) => c.name).sort(), ['Modal', 'ModalContent']);
  const used = contradictedClaims(verdict('Each row uses the `Toggle` component from the design system.'), DIFF, APPKIT);
  assert.deepEqual(used.map((c) => [c.name, c.kind]), [['Toggle', 'use']]);
});

test('a contradicted claim caps the cell at review and shows the rationale', () => {
  const passing: JudgeOutput = {
    verdicts: [
      { rubricId: 'builtin-affordance', pass: true, score: 1, reasoning: 'Imports the Input component and uses its slot.' },
      { rubricId: 'accessible-toggle', pass: true, score: 1, reasoning: 'label flips' },
      { rubricId: 'no-leak', pass: true, score: 1, reasoning: 'never logged' },
    ],
    overallNotes: '',
  };
  const dim = scoreJudgeOutput({ task: TASK, catalog: WITH_INPUT, output: passing, diffPatch: DIFF })!;
  assert.equal(dim.score, 100, 'the score is left alone');
  assert.equal(dim.gate, 'review');
  const note = dim.diffs.find((d) => d.message.startsWith('judge claim contradicted'))!;
  assert.match(note.message, /says Input is imported/);
  assert.match(note.fix!, /Imports the Input component/);
});

test('imports spread over several lines count as imports', () => {
  const multi = [
    '+++ b/src/task/index.tsx',
    '+import React, {',
    '+  Modal,',
    '+  ModalContent,',
    '+  type ModalProps,',
    "+} from '@aurora-appkit/components';",
    '+export const X = () => <Modal><ModalContent /></Modal>;',
  ].join('\n');
  const claims = contradictedClaims(
    verdict('Code imports and uses Modal, ModalContent and ModalProps from the design system, plus React.'),
    multi,
    APPKIT,
  );
  assert.deepEqual(claims, []);
});

test('a component family named by its head is supported by its parts', () => {
  // Verbatim from integrity run 3 (Chakra, bare, confirm-account-deletion): true, and once flagged.
  const parts = [
    '+++ b/src/task/index.tsx',
    "+import { DialogRoot, DialogContent, DialogTitle } from '@chakra-ui/react';",
    '+  const closeDialog = () => setOpen(false);',
    '+  return <DialogRoot><DialogContent><DialogTitle>Delete</DialogTitle></DialogContent></DialogRoot>;',
  ].join('\n');
  const chakra = catalog('chakra', ['Dialog', 'DialogRoot', 'DialogContent', 'DialogTitle', 'Button']);
  const reasoning =
    "The change uses the design system's Dialog components (DialogRoot, DialogBackdrop, DialogPositioner, DialogContent with role=\"alertdialog\", DialogHeader/Title/Description/Footer).";
  assert.deepEqual(contradictedClaims(verdict(reasoning), parts, chakra), []);
  assert.deepEqual(contradictedClaims(verdict('Code imports Dialog from the design system.'), parts, chakra), []);
  // ...but a name that is only a prefix of an unrelated word is still absent.
  assert.deepEqual(contradictedClaims(verdict('Uses the Button component for the cancel action.'), parts, chakra).map((c) => c.name), ['Button']);
});
