// Field-test finding (the Two Audits field test, Aug 2026): the audit only
// ever reads the components package's own package.json, so anything that
// lives in a *sibling* workspace package is invisible to it — an MCP server
// shipped as its own app (Chakra's apps/mcp, Mantine's
// packages/@mantine/mcp-server), a codemod package (Chakra's
// packages/codemod), or a per-package CHANGELOG.md. This module gives every
// check that needs it a cheap way to enumerate workspace package
// directories, so those become evidence instead of false negatives.
//
// Deliberately minimal: no npm/pnpm/yarn workspace-resolution library, no
// general-purpose glob engine. Real monorepos overwhelmingly declare
// workspaces with one of two sources (root package.json "workspaces", or
// pnpm-workspace.yaml) and one of two glob shapes ("packages/*" or
// "packages/@scope/*"), so a tiny segment-by-segment matcher covers the
// field-tested cases without pulling in a dependency.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { load } from 'js-yaml';
import { readJsonSafe } from './util.ts';

export interface WorkspacePackage {
  /** Absolute path to the package directory (contains a package.json). */
  dir: string;
  /** Parsed package.json, or undefined if it exists but failed to parse. */
  pkg: Record<string, unknown> | undefined;
  /** Path relative to root, forward-slash separated regardless of platform. */
  relDir: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** Workspace globs from root package.json's "workspaces" field: either the plain array form, or npm/yarn's `{ packages: [...] }` object form. */
function rootPackageJsonGlobs(root: string): string[] {
  const pkg = readJsonSafe<{ workspaces?: string[] | { packages?: string[] } }>(join(root, 'package.json'));
  const ws = pkg?.workspaces;
  if (!ws) return [];
  if (Array.isArray(ws)) return ws.filter(isNonEmptyString);
  if (Array.isArray(ws.packages)) return ws.packages.filter(isNonEmptyString);
  return [];
}

/**
 * Workspace globs from pnpm-workspace.yaml's "packages" list. Absence or a
 * parse failure is tolerated silently: whatever the other source
 * (root package.json) contributed still stands on its own.
 */
function pnpmWorkspaceGlobs(root: string): string[] {
  const path = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(path)) return [];
  try {
    const parsed = load(readFileSync(path, 'utf8')) as { packages?: unknown } | undefined;
    if (Array.isArray(parsed?.packages)) {
      return parsed.packages.filter(isNonEmptyString);
    }
  } catch {
    // malformed YAML — contribute nothing rather than crashing the audit
  }
  return [];
}

/**
 * Expands one glob pattern against `root` into existing absolute directory
 * paths. Segment-by-segment, not a real glob engine: a literal segment
 * descends directly; a bare "*" segment lists the current directory's
 * subdirectories (directories only, skipping node_modules and dot-dirs —
 * "@"-scoped names like "@scope" don't start with "." so they're never
 * caught by that filter, which is exactly what a "packages/@scope/*" glob
 * needs); a bare "**" segment is a real globstar matching ZERO or more
 * directory levels (capped at GLOBSTAR_MAX_DEPTH) — pnpm treats
 * "packages/**" as "packages and everything under it", and Chakra's
 * pnpm-workspace.yaml doubles it (packages + two consecutive globstar
 * segments), which must still match a depth-1 package like packages/codemod
 * (a one-level-per-star reading silently drops every direct child, the
 * field-tested false negative).
 * Anything more exotic (a partial-segment wildcard like "pkg-*") isn't
 * supported and simply won't match.
 */

// Globstar descent cap: monorepo package dirs live at most a few levels
// under the workspace root; the cap only bounds scan cost on a weird tree.
const GLOBSTAR_MAX_DEPTH = 6;

function listSubdirsOf(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.')) continue;
    out.push(join(dir, entry.name));
  }
  return out;
}

/** `dir` plus every descendant directory down to `depth` levels (globstar's zero-or-more semantics). */
function selfAndDescendants(dir: string, depth: number): string[] {
  const out = [dir];
  if (depth <= 0) return out;
  for (const sub of listSubdirsOf(dir)) out.push(...selfAndDescendants(sub, depth - 1));
  return out;
}

function expandGlob(root: string, pattern: string): string[] {
  const segments = pattern.split('/').filter((s) => s.length > 0);
  let dirs = [root];
  for (const segment of segments) {
    if (segment === '**') {
      const next = new Set<string>();
      for (const dir of dirs) for (const d of selfAndDescendants(dir, GLOBSTAR_MAX_DEPTH)) next.add(d);
      dirs = [...next];
    } else if (segment === '*') {
      const next: string[] = [];
      for (const dir of dirs) next.push(...listSubdirsOf(dir));
      dirs = next;
    } else {
      const next: string[] = [];
      for (const dir of dirs) {
        const candidate = join(dir, segment);
        try {
          if (statSync(candidate).isDirectory()) next.push(candidate);
        } catch {
          // doesn't exist — contributes nothing
        }
      }
      dirs = next;
    }
  }
  return dirs;
}

/**
 * Lists every workspace package directory (one containing a package.json)
 * reachable from the glob patterns declared in root package.json
 * "workspaces" and/or pnpm-workspace.yaml "packages". Never includes the
 * root itself, even when the root has no workspaces at all (empty result in
 * that case). De-duplicated, sorted by relative path for a stable order
 * regardless of filesystem readdir order.
 */
export function listWorkspacePackages(root: string): WorkspacePackage[] {
  const patterns = [...rootPackageJsonGlobs(root), ...pnpmWorkspaceGlobs(root)];
  const positive = patterns.filter((p) => !p.startsWith('!'));
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

  const dirs = new Set<string>();
  for (const pattern of positive) {
    for (const dir of expandGlob(root, pattern)) dirs.add(dir);
  }
  for (const pattern of negative) {
    for (const dir of expandGlob(root, pattern)) dirs.delete(dir);
  }

  const results: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const pkgPath = join(dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    results.push({
      dir,
      pkg: readJsonSafe<Record<string, unknown>>(pkgPath),
      relDir: relative(root, dir).split(sep).join('/'),
    });
  }
  results.sort((a, b) => a.relDir.localeCompare(b.relDir));
  return results;
}
