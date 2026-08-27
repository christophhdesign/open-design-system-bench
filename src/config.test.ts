import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveDataDirs, paths } from './config.ts';

function writeConfig(dir: string, body: Record<string, unknown>): string {
  const configPath = join(dir, 'systems.config.json');
  writeFileSync(configPath, JSON.stringify(body));
  return configPath;
}

test('resolveDataDirs without dataDir falls back to the package dirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsb-config-'));
  try {
    const configPath = writeConfig(dir, { systems: {} });
    const dirs = resolveDataDirs(configPath);
    assert.equal(dirs.catalogsDir, paths.catalogsDir);
    assert.equal(dirs.tokensDir, paths.tokensDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDataDirs resolves a relative dataDir against the config dir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsb-config-'));
  try {
    const configPath = writeConfig(dir, { systems: {}, dataDir: 'data' });
    const dirs = resolveDataDirs(configPath);
    assert.equal(dirs.catalogsDir, join(dir, 'data', 'catalogs'));
    assert.equal(dirs.tokensDir, join(dir, 'data', 'tokens'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDataDirs uses an absolute dataDir as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odsb-config-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'odsb-data-'));
  try {
    mkdirSync(join(dataDir, 'catalogs'), { recursive: true });
    const configPath = writeConfig(dir, { systems: {}, dataDir });
    const dirs = resolveDataDirs(configPath);
    assert.equal(dirs.catalogsDir, join(dataDir, 'catalogs'));
    assert.equal(dirs.tokensDir, join(dataDir, 'tokens'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
