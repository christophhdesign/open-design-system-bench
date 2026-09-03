// Design-systemBgnosticism smoke test: a synthetic SystemsConfig with two
// arbitrary, non-the example system system ids proves the harness has no hardcoded
// assumptions about "systemB"/"systemA" anywhere in the matrix-expansion or
// task-applicability path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BenchConfig, BenchProfile, SystemCatalog, SystemConfig, Task } from '../types.ts';
import { cellKey } from '../types.ts';
import { PKG_ROOT } from '../config.ts';
import { expandMatrix } from './matrix.ts';
import { injectContextForTest, isSelfContainedType, renderCustomElementTypes, templateDir, writeCustomElementTypes } from './fixture.ts';
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

// ---------------------------------------------------------------------------
// Custom-element fixture selection and generated JSX types
// ---------------------------------------------------------------------------

test('templateDir picks the custom-elements template for a custom-element system', () => {
  const base: SystemConfig = {
    root: '/fake/sys',
    rootEnv: 'FAKE_SYS_DIR',
    componentsSrc: 'packages/components/src',
    componentsPkg: '@fake/elements',
    foundationsPkg: '@fake/tokens',
    catalogStrategy: 'docgen',
    agentContext: { agentsMd: [] },
  };
  assert.match(templateDir('sys', { ...base, componentModel: 'custom-elements' }), /custom-elements-app$/);
  // Default and explicit 'react' both keep the existing React template.
  assert.match(templateDir('sys', base), /source-app$/);
  assert.match(templateDir('sys', { ...base, componentModel: 'react' }), /source-app$/);
  // An explicit per-system template still wins over the component model.
  assert.equal(
    templateDir('sys', { ...base, componentModel: 'custom-elements', fixtureTemplate: 'fixtures/npm-app' }),
    join(PKG_ROOT, 'fixtures/npm-app'),
  );
});

const elementCatalog: SystemCatalog = {
  system: 'sys',
  generatedAt: '2026-09-03T00:00:00.000Z',
  source: { root: '/fake/sys', commit: 'abc', srcHash: 'h' },
  components: [
    {
      dir: 'ds-button',
      exports: [
        {
          displayName: 'ds-button',
          description: 'A button.',
          props: [
            { name: 'variant', type: '"primary" | "muted"', required: false },
            { name: 'loading', type: 'boolean', required: false },
            { name: 'controlType', type: '"icon" | "text"', required: false },
            // References a symbol that does not exist in the generated file.
            { name: 'config', type: 'ButtonConfig', required: false },
            { name: 'spacing', type: '"none" | Spacing', required: false },
          ],
        },
      ],
    },
  ],
  allExports: ['ds-button', 'DsButton', 'setAssetPath'],
  allPropsByExport: {
    'ds-button': ['variant', 'loading', 'controlType', 'config', 'spacing', 'control-type', 'onPressed'],
    DsButton: ['variant', 'loading', 'controlType', 'config', 'spacing', 'control-type', 'onPressed'],
    setAssetPath: [],
  },
};

test('renderCustomElementTypes declares every element tag, and only tags', () => {
  const out = renderCustomElementTypes(elementCatalog);

  assert.match(out, /"ds-button": HTMLAttributes<HTMLElement>/);
  // The description becomes a doc comment an agent can read.
  assert.match(out, /\* A button\./);
  // A dash is the custom-element spec's own rule for what is an element, so
  // the PascalCase wrapper spelling and runtime helpers are excluded — they
  // are importable symbols, not tags, and declaring them as JSX intrinsics
  // would invite the agent to write <DsButton> and <setAssetPath>.
  assert.ok(!out.includes('"DsButton"'), 'class-name spelling must not become a JSX intrinsic');
  assert.ok(!out.includes('"setAssetPath"'), 'runtime helper must not become a JSX intrinsic');
});

test('renderCustomElementTypes emits real prop types so invented VALUES fail to compile', () => {
  // Typing every prop `unknown` made an invented value invisible to the whole
  // harness: apiFidelity checks prop names only, so nothing checked values.
  // Measured on a real run before this landed, models wrote size="small",
  // padding="large", state="info" and variant="danger" against elements that
  // accept none of them, and scored 100 on both apiFidelity and compile.
  const out = renderCustomElementTypes(elementCatalog);

  assert.match(out, /"variant"\?: "primary" \| "muted";/);
  assert.match(out, /"loading"\?: boolean;/);
  // An attribute alias accepts exactly what the prop it re-spells accepts.
  assert.match(out, /"control-type"\?: "icon" \| "text";/);
});

test('renderCustomElementTypes degrades a type it cannot resolve to unknown', () => {
  // This .d.ts is compiled as part of every graded workspace, so one
  // unresolvable type name would fail the compile dimension on every cell of
  // the run. Anything referencing an outside symbol degrades instead.
  const out = renderCustomElementTypes(elementCatalog);

  assert.match(out, /"config"\?: unknown;/, 'a referenced interface must not be emitted verbatim');
  assert.match(out, /"spacing"\?: unknown;/, 'a union mixing literals with a named type must degrade whole');
  assert.match(out, /"onPressed"\?: unknown;/, 'an alias with no catalog type of its own stays unknown');
  assert.ok(!out.includes('ButtonConfig'), out.slice(0, 400));
  assert.ok(!out.includes('Spacing'), out.slice(0, 400));
});

test('isSelfContainedType accepts literal unions and primitives, rejects everything else', () => {
  for (const t of ['"a" | "b"', 'boolean', 'string', 'number', '"a"', '1 | 2', '"a" | undefined', 'null']) {
    assert.equal(isSelfContainedType(t), true, `${t} should be emittable`);
  }
  for (const t of [
    'ButtonConfig',
    '"none" | Spacing',
    'string[]',
    '{ open: boolean }',
    '(e: Event) => void',
    'EventEmitter<string>',
    'Record<string, unknown>',
    undefined,
    '',
    'unknown',
  ]) {
    assert.equal(isSelfContainedType(t), false, `${String(t)} should degrade to unknown`);
  }
});

test('writeCustomElementTypes is a no-op for a react system and warns without a catalog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsys-ce-types-'));
  try {
    const base: SystemConfig = {
      root: '/fake/sys',
      rootEnv: 'FAKE_SYS_DIR',
      componentsSrc: 'src',
      componentsPkg: '@fake/elements',
      foundationsPkg: '@fake/tokens',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: [] },
    };
    writeCustomElementTypes('sys', base, dir, undefined);
    assert.ok(!existsSync(join(dir, 'src', 'system-elements.d.ts')), 'react systems get no element declarations');

    // Custom-element system with no extracted catalog: warn, do not throw —
    // the cell still produces gradeable output, it just loses the compile
    // dimension's unknown-tag signal.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      writeCustomElementTypes('sys', { ...base, componentModel: 'custom-elements' }, dir, undefined);
    } finally {
      console.warn = realWarn;
    }
    assert.ok(!existsSync(join(dir, 'src', 'system-elements.d.ts')));
    assert.ok(warnings.some((w) => w.includes('no extracted catalog')), warnings.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Context injection: skill bundles and globbed docs
// ---------------------------------------------------------------------------

function writeF(p: string, content: string): void {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

test('injectContext finds skills whether skillDirs names a bundle or a directory of bundles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-skills-'));
  const dest = mkdtempSync(join(tmpdir(), 'odsys-skills-dest-'));
  try {
    writeF(join(root, 'AGENTS.md'), '# agents\n');
    // A container of bundles — the shape that used to land one level too deep
    // and make every skill invisible to the agent.
    writeF(join(root, '.agents/skills/accessibility/SKILL.md'), '# a11y\n');
    writeF(join(root, '.agents/skills/component-api/SKILL.md'), '# api\n');
    // A single bundle, named directly.
    writeF(join(root, 'tooling/one-skill/SKILL.md'), '# one\n');

    const cfg: SystemConfig = {
      root,
      rootEnv: 'ODSYS_SKILLS_DIR',
      componentsSrc: 'src',
      componentsPkg: '@fake/ui',
      foundationsPkg: '@fake/tokens',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: ['AGENTS.md'], skillDirs: ['.agents/skills', 'tooling/one-skill'] },
    };
    injectContextForTest(cfg, 'skill', dest);

    // Discoverable means .claude/skills/<name>/SKILL.md exactly.
    for (const name of ['accessibility', 'component-api', 'one-skill']) {
      assert.ok(
        existsSync(join(dest, '.claude', 'skills', name, 'SKILL.md')),
        `${name} must be discoverable at .claude/skills/${name}/SKILL.md`,
      );
    }
    assert.ok(
      !existsSync(join(dest, '.claude', 'skills', 'skills')),
      'a container directory must not become a skill level of its own',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('injectContext expands an extraDocs glob and preserves the tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odsys-docs-'));
  const dest = mkdtempSync(join(tmpdir(), 'odsys-docs-dest-'));
  try {
    writeF(join(root, 'AGENTS.md'), '# agents\n');
    writeF(join(root, 'pkg/INDEX.md'), 'see [card](src/card/readme.md)\n');
    writeF(join(root, 'pkg/src/card/readme.md'), '# card\n');
    writeF(join(root, 'pkg/src/alert/readme.md'), '# alert\n');
    writeF(join(root, 'pkg/src/card/card.tsx'), 'export const x = 1;\n');
    writeF(join(root, 'pkg/src/huge.png'), 'binary-ish\n');

    const cfg: SystemConfig = {
      root,
      rootEnv: 'ODSYS_DOCS_DIR',
      componentsSrc: 'pkg/src',
      componentsPkg: '@fake/ui',
      foundationsPkg: '@fake/tokens',
      catalogStrategy: 'docgen',
      agentContext: { agentsMd: ['AGENTS.md'], extraDocs: ['pkg/*.md', 'pkg/src/**/readme.md'] },
    };
    injectContextForTest(cfg, 'skill', dest);

    // Structure is preserved, so INDEX.md's relative link to its sibling
    // readme resolves inside the workspace. Flattening to basename would
    // collapse both readme.md files onto one another.
    assert.ok(existsSync(join(dest, 'docs/pkg/INDEX.md')));
    assert.ok(existsSync(join(dest, 'docs/pkg/src/card/readme.md')));
    assert.ok(existsSync(join(dest, 'docs/pkg/src/alert/readme.md')));
    // The glob copies what it names and nothing else: no implementation
    // source, no image assets an npm consumer would never receive.
    assert.ok(!existsSync(join(dest, 'docs/pkg/src/card/card.tsx')));
    assert.ok(!existsSync(join(dest, 'docs/pkg/src/huge.png')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
