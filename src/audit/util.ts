import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Parses a JSON file, returning undefined on any read/parse failure instead of throwing. */
export function readJsonSafe<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Rounds to 1 decimal place — enough precision for a 0-100 score without noisy floats. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Walks upward from `startDir` (typically `<root>/<componentsSrc>`) looking
 * for the nearest ancestor directory that contains a package.json — the
 * components package's own manifest. componentsSrc nests at different depths
 * across systems (one library puts components one level below its
 * package.json; another puts them two levels
 * below), so a fixed `dirname()` count is wrong for at least one of them.
 * Bounded to stay within `root` and to a handful of hops.
 */
export function findPackageDir(startDir: string, root: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(root)) return undefined;
    dir = parent;
  }
  return undefined;
}
