import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchConfig, SystemId, SystemsConfig } from './types.ts';

export const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const paths = {
  systemsConfig: join(PKG_ROOT, 'systems.config.json'),
  benchConfig: join(PKG_ROOT, 'bench.config.json'),
  tasksDir: join(PKG_ROOT, 'tasks'),
  fixturesDir: join(PKG_ROOT, 'fixtures'),
  catalogsDir: join(PKG_ROOT, 'catalogs'),
  tokensDir: join(PKG_ROOT, 'tokens'),
  runsDir: join(PKG_ROOT, 'runs'),
  baselinesDir: join(PKG_ROOT, 'baselines'),
  // Optional, provider-agnostic model pricing catalog. Absent by default;
  // see the format note at the top of src/providers/pricing.ts.
  pricingCatalog: join(PKG_ROOT, 'pricing-catalog.json'),
};

/**
 * Load `<package root>/.env` into process.env if it exists (native node
 * loader, no deps). Values already present in the real environment take
 * precedence, so a shell export still overrides the file. Returns whether a
 * file was loaded so doctor can report it.
 */
export function loadDotEnv(): boolean {
  const envPath = join(PKG_ROOT, '.env');
  if (!existsSync(envPath)) return false;
  process.loadEnvFile(envPath);
  return true;
}

interface SystemsConfigFile {
  systems: SystemsConfig;
  /**
   * Optional dir (relative to this config file) holding pre-extracted
   * catalogs/tokens, e.g. "data" for a config at examples/<name>/systems.config.json
   * resolves to examples/<name>/data/{catalogs,tokens}. Omit to use the package's
   * top-level catalogs/ and tokens/ dirs (the default, generated-output
   * location that `extract` writes to).
   */
  dataDir?: string;
}

/** Resolves a --config value (or the default systems.config.json) to an absolute path. */
export function resolveSystemsConfigPath(configPath?: string): string {
  return configPath ? resolve(configPath) : paths.systemsConfig;
}

export function loadSystems(configPath: string = paths.systemsConfig): SystemsConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing systems config at ${configPath}. Copy/edit systems.config.json (see README's quickstart) ` +
        `or pass --config <path> to point at one.`,
    );
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SystemsConfigFile;
  const systems = raw.systems ?? {};
  for (const id of Object.keys(systems) as SystemId[]) {
    const cfg = systems[id];
    const override = process.env[cfg.rootEnv];
    if (override) cfg.root = override;
    cfg.root = resolve(cfg.root);
  }
  return systems;
}

/**
 * Where catalogs/ and tokens/ live for a given systems config: the package's
 * top-level generated-output dirs by default, or `<dataDir>/catalogs` and
 * `<dataDir>/tokens` (relative to the config file) when the config declares
 * a `dataDir` — lets an example ship its catalogs/tokens as
 * committed snapshots instead of requiring a live `extract` run.
 */
export function resolveDataDirs(configPath: string = paths.systemsConfig): { catalogsDir: string; tokensDir: string } {
  if (!existsSync(configPath)) {
    return { catalogsDir: paths.catalogsDir, tokensDir: paths.tokensDir };
  }
  let dataDir: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as SystemsConfigFile;
    dataDir = raw.dataDir;
  } catch {
    return { catalogsDir: paths.catalogsDir, tokensDir: paths.tokensDir };
  }
  if (!dataDir) return { catalogsDir: paths.catalogsDir, tokensDir: paths.tokensDir };
  const base = dirname(configPath);
  return { catalogsDir: join(base, dataDir, 'catalogs'), tokensDir: join(base, dataDir, 'tokens') };
}

export function loadBenchConfig(): BenchConfig {
  return JSON.parse(readFileSync(paths.benchConfig, 'utf8')) as BenchConfig;
}

/** Resolves the effective task suite dir: explicit override > bench.config defaults.tasksDir > './tasks'. */
export function resolveTasksDir(bench: BenchConfig, override?: string): string {
  const raw = override ?? bench.defaults.tasksDir ?? './tasks';
  return isAbsolute(raw) ? raw : resolve(PKG_ROOT, raw);
}

export function catalogPath(system: SystemId, catalogsDir: string = paths.catalogsDir): string {
  return join(catalogsDir, `${system}.json`);
}

export function tokensPath(system: SystemId, tokensDir: string = paths.tokensDir): string {
  return join(tokensDir, `${system}.json`);
}

export function requireFile(path: string, hint: string): string {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. ${hint}`);
  }
  return path;
}
