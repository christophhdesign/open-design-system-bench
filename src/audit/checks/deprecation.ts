// Tier-0 check 6: Deprecation legibility. "Agents migrate what they can
// read" — three independent, additive signals: @deprecated JSDoc in the
// component source (machine-parseable, unlike a wiki page), a CHANGELOG.md
// with a machine-readable version-heading structure, and a codemods
// directory hint. None of these can be scored as "good" purely from a count
// (zero @deprecated tags might mean nothing is deprecated, or might mean
// deprecations exist and aren't annotated — a static audit can't tell the
// difference), so this check reports presence, not a hallucination-style
// error count.
//
// Field-test fix (P2 2.4): the changelog and codemod signals used to look
// only at the system root and the components package dir. In a real
// monorepo, both commonly live in a *sibling* workspace package instead —
// Chakra ships packages/codemod, and per-package CHANGELOG.md is the norm
// once a repo has more than one publishable package. Both signals now also
// scan every workspace package via listWorkspacePackages, and a
// .changeset/ directory is recognized as changelog infrastructure in its
// own right (changesets accumulate unreleased-change files instead of a
// single top-level CHANGELOG.md, but they're the same kind of
// agent-legible migration signal). Presence credit is earned once — a
// system with both a CHANGELOG.md and a .changeset/ dir doesn't get double
// points for it — but each gets its own finding, since "how" a system
// tracks changes is useful evidence beyond the single presence bit.
//
// Field-test fix (OSS field test, Aug 2026, Ant Design): the changelog scan
// looked only for the literal filename "CHANGELOG.md". Ant Design ships
// locale-suffixed changelogs instead — CHANGELOG.en-US.md,
// CHANGELOG.zh-CN.md — so the check found none anywhere and reported a
// system with a perfectly good changelog as having no changelog at all.
// Every changelog lookup (root, components package dir, and the
// workspace-package scan) now accepts any `CHANGELOG*.md` filename
// (case-insensitive), and findings name the actual filename matched rather
// than assuming "CHANGELOG.md". When a directory has more than one
// matching file, the plain "CHANGELOG.md" spelling wins if present, else
// the alphabetically first variant — a stable, deterministic pick.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { walkFiles } from '../fs-walk.ts';
import { readJsonSafe, round1, clamp, findPackageDir } from '../util.ts';
import { listWorkspacePackages } from '../workspace.ts';

const DEPRECATED_RE = /@deprecated\b/g;
const VERSION_HEADING_RE = /^##\s+\[?v?\d+\.\d+\.\d+/gm;
const CHANGELOG_FILENAME_RE = /^changelog.*\.md$/i;

/**
 * Finds a CHANGELOG* file directly inside `dir` (not recursive). Accepts any
 * `CHANGELOG*.md` spelling (case-insensitive) so locale-suffixed variants
 * like CHANGELOG.en-US.md are recognized, not just the literal
 * "CHANGELOG.md". When more than one variant is present, prefers the plain
 * "CHANGELOG.md" spelling, then falls back to the alphabetically first
 * match, for a deterministic pick.
 */
function findChangelogFile(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const matches = entries.filter((f) => CHANGELOG_FILENAME_RE.test(f));
  if (matches.length === 0) return undefined;
  if (matches.includes('CHANGELOG.md')) return 'CHANGELOG.md';
  return [...matches].sort()[0];
}

interface PkgJson {
  name?: string;
  scripts?: Record<string, string>;
}

export async function checkDeprecation(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult> {
  const findings: AuditFinding[] = [];
  let score = 0;
  const root = cfg.root;

  // --- @deprecated JSDoc in source (20) ---
  const srcFiles = walkFiles(join(root, cfg.componentsSrc), { extensions: ['.ts', '.tsx'] });
  let deprecatedCount = 0;
  let filesWithDeprecated = 0;
  for (const f of srcFiles) {
    let content: string;
    try {
      content = readFileSync(f.absPath, 'utf8');
    } catch {
      continue;
    }
    const matches = content.match(DEPRECATED_RE);
    if (matches && matches.length > 0) {
      deprecatedCount += matches.length;
      filesWithDeprecated += 1;
    }
  }
  if (deprecatedCount > 0) {
    score += 20;
    findings.push({ severity: 'info', message: `${deprecatedCount} @deprecated annotation(s) found across ${filesWithDeprecated} file(s).` });
  } else {
    findings.push({
      severity: 'info',
      message: 'No @deprecated JSDoc annotations found (either nothing is deprecated, or deprecations are undocumented: static analysis can\'t tell which).',
    });
  }

  // --- CHANGELOG.md / .changeset (40: 25 presence + 15 machine-readable structure) ---
  // Checked at the system root, the components package dir, and every
  // workspace package dir (a monorepo commonly keeps the changelog
  // per-package rather than at the repo root — e.g.
  // packages/components/CHANGELOG.md with none at root at all, or a
  // dedicated apps/docs package's changelog with the rest scattered under
  // packages/*).
  const pkgDir = findPackageDir(join(root, cfg.componentsSrc), root);
  const workspacePkgs = listWorkspacePackages(root);
  const workspaceChangelogs = workspacePkgs
    .filter((wp) => wp.dir !== pkgDir) // avoid double-naming the components package if it's also a workspace member
    .map((wp) => {
      const file = findChangelogFile(wp.dir);
      return file ? { relDir: wp.relDir, file, path: join(wp.dir, file) } : undefined;
    })
    .filter((x): x is { relDir: string; file: string; path: string } => x !== undefined);

  const rootChangelogFile = findChangelogFile(root);
  const hasRootChangelog = rootChangelogFile !== undefined;
  const rootChangelogPath = rootChangelogFile ? join(root, rootChangelogFile) : undefined;
  const componentsChangelogFile = pkgDir ? findChangelogFile(pkgDir) : undefined;
  const hasComponentsChangelog = componentsChangelogFile !== undefined;
  const componentsChangelogPath = pkgDir && componentsChangelogFile ? join(pkgDir, componentsChangelogFile) : undefined;
  const hasChangeset = existsSync(join(root, '.changeset'));
  const hasAnyChangelog = hasRootChangelog || hasComponentsChangelog || workspaceChangelogs.length > 0;

  if (hasAnyChangelog || hasChangeset) {
    score += 25; // presence credit — earned once, regardless of how many of the sources above qualify
  }

  // Machine-readable version-heading scan: the components package's own
  // changelog if it has one (that's the changelog an agent migrating THIS
  // system's components most needs), else whichever changelog was found
  // first (root, then workspace packages in stable relDir order).
  const scanPath = hasComponentsChangelog
    ? componentsChangelogPath
    : [rootChangelogPath, ...workspaceChangelogs.map((w) => w.path)].find((p): p is string => p !== undefined);

  if (scanPath) {
    let content = '';
    try {
      content = readFileSync(scanPath, 'utf8');
    } catch {
      // presence already credited
    }
    const relLocation = scanPath.startsWith(root) ? scanPath.slice(root.length + 1) : scanPath;
    const versionHeadings = content.match(VERSION_HEADING_RE) ?? [];
    if (versionHeadings.length > 0) {
      score += 15;
      findings.push({ severity: 'info', message: `${relLocation} present with ${versionHeadings.length} machine-readable version heading(s).` });
    } else {
      findings.push({ severity: 'warn', message: `${relLocation} present but has no "## <version>" headings an agent can parse for migration context.` });
    }
  } else if (hasChangeset) {
    findings.push({
      severity: 'info',
      message: 'No CHANGELOG*.md found anywhere, but a .changeset/ directory is present (earns changelog-infrastructure credit; run changeset\'s version step to render it into an agent-readable CHANGELOG.md).',
    });
  } else {
    findings.push({
      severity: 'warn',
      message: 'No CHANGELOG*.md at the system root, the components package dir, or any workspace package.',
      fix: 'A machine-readable changelog is a Tier-1 migration eval prerequisite.',
    });
  }

  if (workspaceChangelogs.length > 0) {
    findings.push({
      severity: 'info',
      message: `${workspaceChangelogs.length} workspace package(s) carry their own changelog (e.g. ${workspaceChangelogs[0].relDir}/${workspaceChangelogs[0].file}).`,
    });
  }
  if (hasChangeset) {
    findings.push({ severity: 'info', message: '.changeset/ directory found at the system root (changelog infrastructure).' });
  }

  // --- codemods hint (25) ---
  const codemodDirs = ['codemods', join('scripts', 'codemods')];
  const hasCodemodDir = codemodDirs.some((d) => existsSync(join(root, d)));
  const pkg = readJsonSafe<PkgJson>(join(root, 'package.json'));
  const hasCodemodScript = Object.values(pkg?.scripts ?? {}).some((v) => /codemod/i.test(v)) || Object.keys(pkg?.scripts ?? {}).some((k) => /codemod/i.test(k));
  const workspaceCodemodPkg = workspacePkgs.find((wp) => {
    const name = typeof (wp.pkg as PkgJson | undefined)?.name === 'string' ? ((wp.pkg as PkgJson).name as string) : '';
    return /codemod/i.test(name) || existsSync(join(wp.dir, 'codemods'));
  });
  if (hasCodemodDir || hasCodemodScript || workspaceCodemodPkg) {
    score += 25;
    if (workspaceCodemodPkg) {
      const name = typeof (workspaceCodemodPkg.pkg as PkgJson | undefined)?.name === 'string' ? ` (${(workspaceCodemodPkg.pkg as PkgJson).name})` : '';
      findings.push({ severity: 'info', message: `Codemod package found in workspace package ${workspaceCodemodPkg.relDir}${name}.` });
    } else {
      findings.push({ severity: 'info', message: 'Codemods hint found (codemods/ dir or a codemod script).' });
    }
  } else {
    findings.push({ severity: 'info', message: 'No codemods hint found.' });
  }

  return { id: 'deprecation', title: 'Deprecation legibility', score: round1(clamp(score, 0, 100)), findings };
}
