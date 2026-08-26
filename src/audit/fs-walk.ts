// Small, dependency-free recursive file walker shared by the Tier-0 audit
// checks (surface freshness scan, Code Connect glob, docs-greppability md
// scan, deprecation @deprecated grep, DTCG token file detection). Mirrors the
// spirit of src/extract/normalize.ts's private walkDir, but is exported and
// generic (extension filter, file cap) since multiple audit checks need it.

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DEFAULT_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', '.turbo', '.cache']);

export interface WalkedFile {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

export interface WalkOptions {
  /** Extra directory names to skip, beyond the default vendor/build set. */
  skipDirs?: Set<string>;
  /** Safety valve against pathological trees — audit checks must never hang. Default 50,000. */
  maxFiles?: number;
  /** Only collect files whose name ends with one of these suffixes (e.g. ['.tsx', '.figma.ts']). */
  extensions?: string[];
}

/**
 * Recursively walks `rootDir`, skipping node_modules/dist/build/etc and any
 * dot-directory (`.git`, `.next`, editor caches, …), returning every regular
 * file found (optionally filtered by suffix). Best-effort: unreadable
 * directories are silently skipped rather than throwing, because every audit
 * check must degrade gracefully instead of crashing the whole run.
 */
export function walkFiles(rootDir: string, opts: WalkOptions = {}): WalkedFile[] {
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxFiles = opts.maxFiles ?? 50_000;
  const extensions = opts.extensions;
  const out: WalkedFile[] = [];

  function walk(absDir: string): void {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable / doesn't exist — contributes nothing
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || skipDirs.has(entry.name)) continue;
        walk(join(absDir, entry.name));
      } else if (entry.isFile()) {
        if (extensions && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
        const abs = join(absDir, entry.name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        out.push({ relPath: relative(rootDir, abs), absPath: abs, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }

  walk(rootDir);
  return out;
}

/** Highest mtimeMs among the given files, or undefined if the list is empty. */
export function newestMtime(files: WalkedFile[]): number | undefined {
  return files.length === 0 ? undefined : Math.max(...files.map((f) => f.mtimeMs));
}
