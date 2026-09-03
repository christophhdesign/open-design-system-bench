import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DimensionResult, SystemCatalog, SystemConfig, SystemTokens, Task } from '../types.ts';
import { analyzeSource } from './ast.ts';
import type { AnalyzedFile, GradeContext } from './context.ts';
import { gradeImports } from './mechanical/imports.ts';
import { gradeApiFidelity } from './mechanical/api-fidelity.ts';
import { gradeTokenDiscipline } from './mechanical/token-discipline.ts';
import { gradeA11yStatic } from './mechanical/a11y-static.ts';
import { gradeCompile } from './mechanical/compile.ts';
import { composeResult } from './score.ts';

// ---------------------------------------------------------------------------
// Fixtures: a fake the design system catalog/tokens/config, standing in for the real
// docgen-generated ones so these tests don't depend on the sibling kit repos.
// ---------------------------------------------------------------------------

const catalog: SystemCatalog = {
  system: 'systemB',
  generatedAt: new Date().toISOString(),
  source: { root: '/fake/systemB', commit: 'deadbeef', srcHash: 'hash' },
  components: [
    { dir: 'button', exports: [{ displayName: 'Button', description: 'A button', props: [] }] },
    { dir: 'modal', exports: [{ displayName: 'Modal', description: 'A modal', props: [] }] },
  ],
  allExports: ['Button', 'Modal'],
  allPropsByExport: {
    Button: ['variant', 'size', 'iconLeading'],
    Modal: ['open', 'onClose'],
  },
};

const tokens: SystemTokens = {
  system: 'systemB',
  generatedAt: new Date().toISOString(),
  cssVars: ['--text-primary'],
  utilities: ['bodyMd', 'headingXl'],
  typographyUtilities: ['bodyMd', 'headingXl'],
  cssHash: 'hash',
};

const systemCfg: SystemConfig = {
  root: '/fake/systemB',
  rootEnv: 'MY_SYSTEM_DIR',
  componentsSrc: 'packages/components/src',
  componentsPkg: '@acme-ui/components',
  foundationsPkg: '@acme-ui/foundations',
  foundationsCss: 'packages/foundations/src/index.css',
  catalogStrategy: 'docgen',
  agentContext: { agentsMd: [] },
  contamination: { props: ['iconStart', 'iconEnd'], typographyStyle: 'camel' },
};

const task: Task = {
  id: 'fake-task',
  title: 'Fake task',
  systems: ['systemB'],
  prompt: 'Build something with the design system',
  hiddenExpectations: { componentsAnyOf: {} },
  rubrics: [],
};

function file(path: string, source: string): AnalyzedFile {
  return { path, source, analysis: analyzeSource(path, source) };
}

function makeCtx(files: AnalyzedFile[]): GradeContext {
  return {
    system: 'systemB',
    systemCfg,
    catalog,
    tokens,
    task,
    files,
    workspaceDir: '/fake/workspace',
  };
}

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

test('gradeImports passes a relative + system-package import', () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `import { Button } from '@acme-ui/components';\nimport { helper } from './util';\n`,
    ),
  ]);
  const result = gradeImports(ctx);
  assert.equal(result.gate, 'pass');
  assert.equal(result.score, 100);
});

test('gradeImports flags a disallowed foreign import', () => {
  const ctx = makeCtx([file('src/App.tsx', `import { Button } from 'antd';\n`)]);
  const result = gradeImports(ctx);
  assert.equal(result.gate, 'review');
  assert.ok(result.diffs.some((d) => d.message.includes('antd')));
});

// ---------------------------------------------------------------------------
// apiFidelity
// ---------------------------------------------------------------------------

test('gradeApiFidelity fails the gate on a hallucinated component import', () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `import { Buttn } from '@acme-ui/components';\nexport function App() { return <Buttn />; }\n`,
    ),
  ]);
  const result = gradeApiFidelity(ctx);
  assert.equal(result.gate, 'fail');
  assert.ok(result.diffs.some((d) => d.message.includes('Buttn')));
});

test('gradeApiFidelity puts an invented prop at review, not fail', () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `import { Button } from '@acme-ui/components';\nexport function App() { return <Button madeUpProp="x" />; }\n`,
    ),
  ]);
  const result = gradeApiFidelity(ctx);
  assert.equal(result.gate, 'review');
  assert.ok(result.diffs.some((d) => d.message.includes('madeUpProp')));
});

test('gradeApiFidelity tags cross-system contamination props', () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `import { Button } from '@acme-ui/components';\nexport function App() { return <Button iconStart="i" />; }\n`,
    ),
  ]);
  const result = gradeApiFidelity(ctx);
  assert.ok(
    result.diffs.some((d) => d.message.includes('iconStart') && d.message.includes('[cross-system-contamination]')),
  );
});

test('gradeApiFidelity does not penalize member-expression (sub-component) attrs', () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `import { Modal } from '@acme-ui/components';\nexport function App() { return <Modal.Footer anything="x" />; }\n`,
    ),
  ]);
  const result = gradeApiFidelity(ctx);
  assert.equal(result.score, 100);
  assert.ok(result.diffs.some((d) => d.message.includes('Modal.Footer')));
});

test('gradeApiFidelity scores 0 and fails when no design-system components are used', () => {
  const ctx = makeCtx([file('src/App.tsx', `export function App() { return <div />; }\n`)]);
  const result = gradeApiFidelity(ctx);
  assert.equal(result.score, 0);
  assert.equal(result.gate, 'fail');
  assert.ok(result.diffs.some((d) => d.message.includes('no design-system components used')));
});

// ---------------------------------------------------------------------------
// tokenDiscipline
// ---------------------------------------------------------------------------

test('gradeTokenDiscipline flags a raw hex color in a Tailwind arbitrary value', () => {
  const ctx = makeCtx([file('src/App.tsx', `export function App() { return <div className="bg-[#ff0000]" />; }\n`)]);
  const result = gradeTokenDiscipline(ctx);
  assert.notEqual(result.gate, 'pass');
  assert.ok(result.diffs.some((d) => d.message.includes('#ff0000')));
});

test('gradeTokenDiscipline leaves ordinary Tailwind utility classes alone', () => {
  const ctx = makeCtx([file('src/App.tsx', `export function App() { return <div className="p-4 flex gap-2" />; }\n`)]);
  const result = gradeTokenDiscipline(ctx);
  assert.equal(result.gate, 'pass');
  assert.equal(result.diffs.length, 0);
});

// ---------------------------------------------------------------------------
// a11yStatic
// ---------------------------------------------------------------------------

test('gradeA11yStatic flags an <img> missing alt', async () => {
  const ctx = makeCtx([file('src/App.tsx', `export function App() { return <img src="x.png" />; }\n`)]);
  const result = await gradeA11yStatic(ctx);
  assert.equal(result.gate, 'review');
  assert.ok(result.diffs.some((d) => d.message.toLowerCase().includes('alt')));
});

test('gradeA11yStatic flags an unlabeled Toggle sitting next to a span', async () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `export function App() {
        return (
          <div>
            <span>Crash reports</span>
            <Toggle checked={false} onChange={() => {}} />
          </div>
        );
      }\n`,
    ),
  ]);
  const result = await gradeA11yStatic(ctx);
  assert.equal(result.gate, 'review');
  assert.ok(result.diffs.some((d) => d.message.includes('<Toggle>') && d.message.includes('accessible name')));
});

test('gradeA11yStatic passes a Toggle associated via htmlFor / id', async () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `export function App() {
        return (
          <div>
            <label htmlFor="crash">Crash reports</label>
            <Toggle id="crash" checked={false} onChange={() => {}} />
          </div>
        );
      }\n`,
    ),
  ]);
  const result = await gradeA11yStatic(ctx);
  assert.equal(result.gate, 'pass');
  assert.equal(result.score, 100);
});

test('gradeA11yStatic passes an Input inside FormField', async () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `export function App() {
        return (
          <FormField>
            <FormLabel>Email</FormLabel>
            <FormControl>
              <Input type="email" />
            </FormControl>
          </FormField>
        );
      }\n`,
    ),
  ]);
  const result = await gradeA11yStatic(ctx);
  assert.equal(result.gate, 'pass');
});

test('gradeA11yStatic flags an IconButton with no accessible name', async () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `export function App() {
        return (
          <IconButton onClick={() => {}}>
            <Icon name="Eye" />
          </IconButton>
        );
      }\n`,
    ),
  ]);
  const result = await gradeA11yStatic(ctx);
  assert.equal(result.gate, 'review');
  assert.ok(result.diffs.some((d) => d.message.includes('<IconButton>')));
});

test('gradeA11yStatic passes an IconButton with aria-label', async () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `export function App() {
        return (
          <IconButton aria-label="Show password" onClick={() => {}}>
            <Icon name="Eye" />
          </IconButton>
        );
      }\n`,
    ),
  ]);
  const result = await gradeA11yStatic(ctx);
  assert.equal(result.gate, 'pass');
});

test('gradeA11yStatic honours a system-declared control name', async () => {
  // A library whose text field is called TextEntry is invisible to the
  // conventional defaults; declaring it must make the grader see it.
  const src = file(
    'src/App.tsx',
    `export function App() {
        return <TextEntry value="" onChange={() => {}} />;
      }\n`,
  );
  const bare = await gradeA11yStatic(makeCtx([src]));
  assert.equal(bare.gate, 'pass', 'unknown tag is not a control by default');

  const ctx = { ...makeCtx([src]), systemCfg: { ...systemCfg, a11y: { controls: ['TextEntry'] } } };
  const declared = await gradeA11yStatic(ctx);
  assert.notEqual(declared.gate, 'pass', 'declared control with no accessible name must be flagged');
  assert.ok(declared.diffs.some((d) => d.message.includes('TextEntry')));
});

test('gradeA11yStatic keeps the conventional defaults when a system declares extras', async () => {
  const ctx = {
    ...makeCtx([
      file('src/App.tsx', `export function App() { return <Toggle checked={false} onChange={() => {}} />; }\n`),
    ]),
    systemCfg: { ...systemCfg, a11y: { controls: ['TextEntry'] } },
  };
  const result = await gradeA11yStatic(ctx);
  assert.notEqual(result.gate, 'pass', 'declaring extras must extend, not replace, the defaults');
});

test('placeholder only names a control where the system opts in', async () => {
  const src = file(
    'src/App.tsx',
    `export function App() { return <Finder placeholder="Search docs" />; }\n`,
  );
  const strict = await gradeA11yStatic({
    ...makeCtx([src]),
    systemCfg: { ...systemCfg, a11y: { controls: ['Finder'] } },
  });
  assert.notEqual(strict.gate, 'pass', 'placeholder alone is not an accessible name by default');

  const optedIn = await gradeA11yStatic({
    ...makeCtx([src]),
    systemCfg: { ...systemCfg, a11y: { controls: ['Finder'], placeholderNamed: ['Finder'] } },
  });
  assert.equal(optedIn.gate, 'pass', 'a documented placeholder contract is honoured');
});

test('gradeA11yStatic passes a Checkbox that exposes a label prop', async () => {
  const ctx = makeCtx([
    file('src/App.tsx', `export function App() { return <Checkbox label="Email notifications" />; }\n`),
  ]);
  const result = await gradeA11yStatic(ctx);
  assert.equal(result.gate, 'pass');
});

// ---------------------------------------------------------------------------
// clean file -> everything passes
// ---------------------------------------------------------------------------

test('a clean file passes imports, apiFidelity, tokenDiscipline, and a11yStatic', async () => {
  const ctx = makeCtx([
    file(
      'src/App.tsx',
      `
      import { Button } from '@acme-ui/components';

      export function App() {
        return (
          <Button variant="primary" size="md" className="p-4 flex gap-2" onClick={() => {}}>
            Save
          </Button>
        );
      }
      `,
    ),
  ]);

  assert.equal(gradeImports(ctx).gate, 'pass');
  assert.equal(gradeApiFidelity(ctx).gate, 'pass');
  assert.equal(gradeTokenDiscipline(ctx).gate, 'pass');
  assert.equal((await gradeA11yStatic(ctx)).gate, 'pass');
});

// ---------------------------------------------------------------------------
// compile — only checked for the failure path (missing tsconfig); a real
// successful `tsc --noEmit` run needs a full generated workspace, which is
// out of scope for these unit tests.
// ---------------------------------------------------------------------------

test('gradeCompile fails the gate when the workspace has no tsconfig.json', async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'agent-evals-compile-test-'));
  const ctx = makeCtx([]);
  ctx.workspaceDir = scratchDir;
  const result = await gradeCompile(ctx);
  assert.equal(result.gate, 'fail');
  assert.equal(result.score, 0);
  assert.ok(result.diffs.length > 0);
});

// ---------------------------------------------------------------------------
// score composition
// ---------------------------------------------------------------------------

test('composeResult renormalizes weights over present dimensions (no judgment dimension)', () => {
  const dims: DimensionResult[] = [
    { dimension: 'imports', score: 100, gate: 'pass', diffs: [] },
    { dimension: 'apiFidelity', score: 80, gate: 'review', diffs: [{ dimension: 'apiFidelity', message: 'x' }] },
    { dimension: 'tokenDiscipline', score: 100, gate: 'pass', diffs: [] },
    { dimension: 'a11yStatic', score: 100, gate: 'pass', diffs: [] },
    { dimension: 'compile', score: 100, gate: 'pass', diffs: [] },
  ];
  const result = composeResult(dims);

  // weights present: imports .10, apiFidelity .25, tokenDiscipline .15, a11yStatic .10, compile .10 -> sum .70
  const expected = (0.1 * 100 + 0.25 * 80 + 0.15 * 100 + 0.1 * 100 + 0.1 * 100) / 0.7;
  assert.ok(Math.abs(result.overall - expected) < 1e-9, `expected ~${expected}, got ${result.overall}`);
  assert.equal(result.gate, 'review'); // worst-case across dimensions
  assert.equal(result.diffs.length, 1);
  assert.equal(Object.keys(result.dimensions).length, 5);
});

test('composeResult lands 0-100 even with a single dimension present', () => {
  const result = composeResult([{ dimension: 'compile', score: 50, gate: 'pass', diffs: [] }]);
  assert.equal(result.overall, 50);
  assert.equal(result.gate, 'pass');
});

test('composeResult worst-case gate ordering: fail beats review beats pass', () => {
  const result = composeResult([
    { dimension: 'imports', score: 100, gate: 'pass', diffs: [] },
    { dimension: 'apiFidelity', score: 0, gate: 'fail', diffs: [] },
    { dimension: 'tokenDiscipline', score: 100, gate: 'review', diffs: [] },
  ]);
  assert.equal(result.gate, 'fail');
});

// ---------------------------------------------------------------------------
// apiFidelity for a custom-element system
// ---------------------------------------------------------------------------
//
// A web-component library has no per-component import: the bundle registers
// the elements once and consumers write tags. Import-anchored usage detection
// therefore scored a flawless answer as "no design-system components used" —
// zero, hard fail, the harness's own worst-outcome signal fired on the best
// possible output.

const ceCatalog: SystemCatalog = {
  system: 'systemCE',
  generatedAt: new Date().toISOString(),
  source: { root: '/fake/systemCE', commit: 'deadbeef', srcHash: 'hash' },
  components: [
    { dir: 'ds-button', exports: [{ displayName: 'ds-button', description: 'A button', props: [] }] },
    { dir: 'ds-alert', exports: [{ displayName: 'ds-alert', description: 'An alert', props: [] }] },
  ],
  allExports: ['ds-button', 'ds-alert', 'DsButton', 'DsAlert'],
  allPropsByExport: {
    'ds-button': ['variant', 'width', 'control-type'],
    DsButton: ['variant', 'width', 'control-type'],
    'ds-alert': ['state'],
    DsAlert: ['state'],
  },
};

const ceCfg: SystemConfig = {
  ...systemCfg,
  componentsPkg: '@acme-ui/elements',
  componentModel: 'custom-elements',
  contamination: undefined,
};

function makeCeCtx(files: AnalyzedFile[]): GradeContext {
  return { system: 'systemCE', systemCfg: ceCfg, catalog: ceCatalog, tokens, task, files, workspaceDir: '/fake/workspace' };
}

test('gradeApiFidelity counts import-less custom-element tags as design-system usage', () => {
  const ctx = makeCeCtx([
    file('src/task/index.tsx', `export function T() { return <ds-button variant="muted">Go</ds-button>; }\n`),
  ]);
  const r = gradeApiFidelity(ctx);
  assert.equal(r.gate, 'pass', JSON.stringify(r.diffs));
  assert.equal(r.score, 100);
  assert.ok(
    !r.diffs.some((d) => d.message.includes('no design-system components used')),
    'a correct custom-element answer must not read as ignoring the design system',
  );
});

test('gradeApiFidelity accepts a kebab attribute alias on a custom element', () => {
  const ctx = makeCeCtx([
    file('src/task/index.tsx', `export function T() { return <ds-button control-type="text" aria-label="Go" />; }\n`),
  ]);
  assert.equal(gradeApiFidelity(ctx).gate, 'pass');
});

test('gradeApiFidelity still flags an invented prop on a custom element', () => {
  const ctx = makeCeCtx([
    file('src/task/index.tsx', `export function T() { return <ds-alert severity="error" />; }\n`),
  ]);
  const r = gradeApiFidelity(ctx);
  assert.equal(r.gate, 'review');
  assert.ok(r.diffs.some((d) => d.message.includes("Invented prop 'severity'")), JSON.stringify(r.diffs));
});

test('gradeApiFidelity fails a custom-element system that used no elements at all', () => {
  const ctx = makeCeCtx([
    file('src/task/index.tsx', `export function T() { return <div><button>Go</button></div>; }\n`),
  ]);
  const r = gradeApiFidelity(ctx);
  assert.equal(r.gate, 'fail');
  assert.equal(r.score, 0);
  assert.ok(r.diffs.some((d) => d.message.includes('no design-system components used')));
});

test('gradeApiFidelity leaves the react model import-anchored: a bare tag is not system usage', () => {
  // Same source under the default 'react' model. "button" is not a catalog
  // export and nothing was imported, so this is still the ignored-the-system
  // case — tag-name resolution must not leak into the react path.
  const ctx = makeCtx([file('src/App.tsx', `export function T() { return <Button variant="x" />; }\n`)]);
  const r = gradeApiFidelity(ctx);
  assert.equal(r.gate, 'fail');
  assert.ok(r.diffs.some((d) => d.message.includes('no design-system components used')));
});
