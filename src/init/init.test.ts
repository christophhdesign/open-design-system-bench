import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from './wizard.ts';
import type { SystemConfig } from '../types.ts';

interface SystemsConfigFileShape {
  systems: Record<string, SystemConfig>;
}

function tmpCwd(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// npm answers -> well-shaped systems.config.json
// ---------------------------------------------------------------------------

test('runInit non-interactive npm answers writes a well-shaped systems.config.json', async () => {
  const cwd = tmpCwd('odsys-init-npm-');
  try {
    const result = await runInit({
      nonInteractive: true,
      cwd,
      answers: {
        systemId: 'acme',
        displayName: 'Acme UI',
        consume: 'npm',
        packageSpec: '@acme/ui@^2.0.0',
        cssEntry: '@acme/ui/styles.css',
      },
    });

    assert.equal(result.configPath, join(cwd, 'systems.config.json'));
    assert.match(result.summary, /Added system "acme"/);

    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as SystemsConfigFileShape;
    const cfg = written.systems.acme;
    assert.ok(cfg, 'expected an "acme" entry');
    assert.equal(cfg.consume, 'npm');
    assert.equal(cfg.packageSpec, '@acme/ui@^2.0.0');
    assert.equal(cfg.componentsPkg, '@acme/ui'); // version stripped
    assert.equal(cfg.foundationsPkg, '@acme/ui'); // defaults to componentsPkg
    assert.equal(cfg.cssEntry, '@acme/ui/styles.css');
    assert.equal(cfg.rootEnv, 'OPEN_DESIGN_SYSTEM_BENCH_ACME_DIR');
    assert.equal(cfg.root, cwd); // npm mode defaults root to cwd when unset
    assert.deepEqual(cfg.agentContext.agentsMd, ['AGENTS.md', 'README.md']);
    assert.ok(['docgen', 'catalog-json'].includes(cfg.catalogStrategy));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit summary warns when catalogStrategy is left unset in npm mode', async () => {
  const cwd = tmpCwd('odsys-init-npm-warn-');
  try {
    const result = await runInit({
      nonInteractive: true,
      cwd,
      answers: { systemId: 'acme', consume: 'npm', packageSpec: '@acme/ui' },
    });
    assert.match(result.summary, /warn catalogStrategy not chosen yet/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Merge semantics: never clobbers other systems; same id replaces cleanly
// ---------------------------------------------------------------------------

test('running init again with a second id merges without clobbering the first', async () => {
  const cwd = tmpCwd('odsys-init-merge-');
  try {
    await runInit({ nonInteractive: true, cwd, answers: { systemId: 'first', consume: 'npm', packageSpec: '@first/ui' } });
    const result = await runInit({ nonInteractive: true, cwd, answers: { systemId: 'second', consume: 'npm', packageSpec: '@second/ui' } });

    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as SystemsConfigFileShape;
    assert.ok(written.systems.first, 'expected "first" to survive the second init run');
    assert.ok(written.systems.second, 'expected "second" to be added');
    assert.equal(written.systems.first.packageSpec, '@first/ui');
    assert.equal(written.systems.second.packageSpec, '@second/ui');
    assert.equal(Object.keys(written.systems).length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('running init again with the same id in non-interactive mode replaces it (no clobbering other ids)', async () => {
  const cwd = tmpCwd('odsys-init-replace-');
  try {
    await runInit({ nonInteractive: true, cwd, answers: { systemId: 'other', consume: 'npm', packageSpec: '@other/ui' } });
    await runInit({ nonInteractive: true, cwd, answers: { systemId: 'acme', consume: 'npm', packageSpec: '@acme/ui@1.0.0' } });
    const result = await runInit({ nonInteractive: true, cwd, answers: { systemId: 'acme', consume: 'npm', packageSpec: '@acme/ui@2.0.0' } });

    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as SystemsConfigFileShape;
    assert.equal(Object.keys(written.systems).length, 2);
    assert.equal(written.systems.acme.packageSpec, '@acme/ui@2.0.0');
    assert.equal(written.systems.other.packageSpec, '@other/ui');
    assert.match(result.summary, /Replaced system "acme"/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('running init preserves an existing dataDir field in systems.config.json', async () => {
  const cwd = tmpCwd('odsys-init-datadir-');
  try {
    writeFileSync(join(cwd, 'systems.config.json'), JSON.stringify({ dataDir: 'data', systems: {} }, null, 2));
    const result = await runInit({ nonInteractive: true, cwd, answers: { systemId: 'acme', consume: 'npm', packageSpec: '@acme/ui' } });
    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as { dataDir?: string };
    assert.equal(written.dataDir, 'data');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Starter task scaffolding: only when tasks/ is empty, never overwritten
// ---------------------------------------------------------------------------

test('runInit scaffolds three starter tasks into an empty tasks/ dir', async () => {
  const cwd = tmpCwd('odsys-init-tasks-empty-');
  try {
    await runInit({ nonInteractive: true, cwd, answers: { systemId: 'acme', consume: 'npm', packageSpec: '@acme/ui' } });
    const files = readdirSync(join(cwd, 'tasks')).sort();
    assert.deepEqual(files, ['confirm-account-deletion.yaml', 'settings-toggle-section.yaml', 'success-feedback.yaml']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit never overwrites an existing non-empty tasks/ dir', async () => {
  const cwd = tmpCwd('odsys-init-tasks-nonempty-');
  try {
    mkdirSync(join(cwd, 'tasks'), { recursive: true });
    writeFileSync(join(cwd, 'tasks', 'custom-task.yaml'), 'id: custom-task\n');
    const result = await runInit({ nonInteractive: true, cwd, answers: { systemId: 'acme', consume: 'npm', packageSpec: '@acme/ui' } });
    const files = readdirSync(join(cwd, 'tasks'));
    assert.deepEqual(files, ['custom-task.yaml']);
    assert.match(result.summary, /tasks\/ already has 1 task file\(s\) — left untouched/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source mode against a synthetic repo dir
// ---------------------------------------------------------------------------

test('runInit source-mode against a synthetic repo produces ok doctor-grade lines', async () => {
  const repo = tmpCwd('odsys-source-repo-');
  const cwd = tmpCwd('odsys-init-source-');
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'tsconfig.json'), '{}\n');
    writeFileSync(join(repo, 'AGENTS.md'), '# agents\n');
    writeFileSync(join(repo, 'README.md'), '# readme\n');

    const result = await runInit({
      nonInteractive: true,
      cwd,
      answers: {
        systemId: 'synthkit',
        consume: 'source',
        root: repo,
        componentsSrc: 'src',
      },
    });

    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as SystemsConfigFileShape;
    const cfg = written.systems.synthkit;
    assert.equal(cfg.consume, undefined); // 'source' is the implicit default — omitted, not persisted
    assert.equal(cfg.root, repo);
    assert.equal(cfg.catalogStrategy, 'docgen');

    assert.match(result.summary, /ok\s+consume: source/);
    assert.match(result.summary, /ok\s+componentsSrc exists/);
    assert.match(result.summary, /ok\s+tsconfig found for docgen/);
    assert.match(result.summary, /ok\s+agents-md doc found.*AGENTS\.md/);
    assert.match(result.summary, /ok\s+agents-md doc found.*README\.md/);
    assert.doesNotMatch(result.summary, /warn componentsSrc/);
    assert.doesNotMatch(result.summary, /warn tsconfig/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit source-mode warns when componentsSrc/tsconfig/docs are missing', async () => {
  const repo = tmpCwd('odsys-source-repo-empty-');
  const cwd = tmpCwd('odsys-init-source-empty-');
  try {
    const result = await runInit({
      nonInteractive: true,
      cwd,
      answers: { systemId: 'synthkit', consume: 'source', root: repo, componentsSrc: 'src' },
    });
    assert.match(result.summary, /warn componentsSrc not found/);
    assert.match(result.summary, /warn tsconfig not found/);
    assert.match(result.summary, /warn agents-md doc not found.*AGENTS\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hard validation
// ---------------------------------------------------------------------------

test('runInit throws when consume=source and root does not exist', async () => {
  const cwd = tmpCwd('odsys-init-badsource-');
  try {
    await assert.rejects(
      runInit({
        nonInteractive: true,
        cwd,
        answers: { systemId: 'x', consume: 'source', root: '/definitely/not/a/real/path/open-design-system-bench-test' },
      }),
      /root/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit throws when consume=npm and packageSpec is empty', async () => {
  const cwd = tmpCwd('odsys-init-badnpm-');
  try {
    await assert.rejects(
      runInit({ nonInteractive: true, cwd, answers: { systemId: 'x', consume: 'npm', packageSpec: '' } }),
      /packageSpec/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit throws when systemId is missing in non-interactive mode', async () => {
  const cwd = tmpCwd('odsys-init-noid-');
  try {
    await assert.rejects(
      runInit({ nonInteractive: true, cwd, answers: { consume: 'npm', packageSpec: '@acme/ui' } }),
      /systemId/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit throws when non-interactive mode is missing answers entirely', async () => {
  const cwd = tmpCwd('odsys-init-noanswers-');
  try {
    await assert.rejects(runInit({ nonInteractive: true, cwd }), /answers/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// componentsPkg / foundationsPkg derivation
// ---------------------------------------------------------------------------

test('runInit derives componentsPkg from systemId in source mode when not given', async () => {
  const repo = tmpCwd('odsys-source-repo-derive-');
  const cwd = tmpCwd('odsys-init-derive-');
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    const result = await runInit({
      nonInteractive: true,
      cwd,
      answers: { systemId: 'Cool Kit', consume: 'source', root: repo, componentsSrc: 'src' },
    });
    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as SystemsConfigFileShape;
    assert.equal(written.systems['Cool Kit'].componentsPkg, '@cool-kit/components');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit respects an explicit componentsPkg/foundationsPkg override', async () => {
  const cwd = tmpCwd('odsys-init-override-');
  try {
    const result = await runInit({
      nonInteractive: true,
      cwd,
      answers: {
        systemId: 'acme',
        consume: 'npm',
        packageSpec: '@acme/ui',
        componentsPkg: '@acme/components',
        foundationsPkg: '@acme/tokens',
      },
    });
    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as SystemsConfigFileShape;
    assert.equal(written.systems.acme.componentsPkg, '@acme/components');
    assert.equal(written.systems.acme.foundationsPkg, '@acme/tokens');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runInit round-trips a catalog-json strategy with catalogFile', async () => {
  const repo = tmpCwd('odsys-source-repo-catjson-');
  const cwd = tmpCwd('odsys-init-catjson-');
  try {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'catalog.json'), '{}\n');
    const result = await runInit({
      nonInteractive: true,
      cwd,
      answers: {
        systemId: 'acme',
        consume: 'source',
        root: repo,
        componentsSrc: 'src',
        catalogStrategy: 'catalog-json',
        catalogFile: 'catalog.json',
      },
    });
    const written = JSON.parse(readFileSync(result.configPath, 'utf8')) as SystemsConfigFileShape;
    assert.equal(written.systems.acme.catalogStrategy, 'catalog-json');
    assert.equal(written.systems.acme.catalogFile, 'catalog.json');
    assert.match(result.summary, /ok\s+catalogFile exists/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Config file is valid, pretty-printed JSON ending in a newline
// ---------------------------------------------------------------------------

test('runInit writes systems.config.json as pretty JSON with a trailing newline', async () => {
  const cwd = tmpCwd('odsys-init-format-');
  try {
    const result = await runInit({ nonInteractive: true, cwd, answers: { systemId: 'acme', consume: 'npm', packageSpec: '@acme/ui' } });
    const raw = readFileSync(result.configPath, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(raw.includes('  "systems"')); // 2-space indent
    assert.ok(existsSync(result.configPath));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
