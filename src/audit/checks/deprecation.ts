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

// A machine-readable version heading, in the two shapes real projects write.
// The semver form (`## 1.2.0`, `## [v2.0.0]`) is the changelog convention; the
// transition form (`## 30 -> 31`, `## v3 to v4`) is how hand-written migration
// guides head their sections, and is exactly as parseable. Requiring at least
// major.minor for the semver form, and two numbers around an arrow/`to` for
// the transition form, keeps prose headings like "## 2026 in review" out.
const VERSION_HEADING_RE = /^##\s+\[?v?\d+\.\d+(?:\.\d+)?|^##\s+v?\d+\s*(?:->|-->|→|to)\s*v?\d+/gm;

// Migration documentation an agent can read, in filename-preference order.
// CHANGELOG is not the only shape: a hand-written MIGRATION.md or UPGRADING.md
// carries the same information in a more directly actionable form (Admiral
// ships a 1500-line MIGRATION.md with before/after snippets per deprecation
// and no CHANGELOG at all, and used to score zero here for it).
const MIGRATION_DOC_PATTERNS: Array<{ re: RegExp; preferred: string; kind: string }> = [
  { re: /^changelog.*\.md$/i, preferred: 'CHANGELOG.md', kind: 'changelog' },
  { re: /^migration.*\.md$/i, preferred: 'MIGRATION.md', kind: 'migration guide' },
  { re: /^upgrading.*\.md$/i, preferred: 'UPGRADING.md', kind: 'upgrade guide' },
];

/**
 * Finds a CHANGELOG* file directly inside `dir` (not recursive). Accepts any
 * `CHANGELOG*.md` spelling (case-insensitive) so locale-suffixed variants
 * like CHANGELOG.en-US.md are recognized, not just the literal
 * "CHANGELOG.md". When more than one variant is present, prefers the plain
 * "CHANGELOG.md" spelling, then falls back to the alphabetically first
 * match, for a deterministic pick.
 */
function findMigrationDoc(dir: string): { file: string; kind: string } | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  // Deterministic across the whole set: changelog wins over migration guide
  // wins over upgrade guide, and within one kind the plain spelling wins over
  // a locale-suffixed variant, else the alphabetically first.
  for (const { re, preferred, kind } of MIGRATION_DOC_PATTERNS) {
    const matches = entries.filter((f) => re.test(f));
    if (matches.length === 0) continue;
    if (matches.includes(preferred)) return { file: preferred, kind };
    return { file: [...matches].sort()[0], kind };
  }
  return undefined;
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
      const found = findMigrationDoc(wp.dir);
      return found ? { relDir: wp.relDir, file: found.file, kind: found.kind, path: join(wp.dir, found.file) } : undefined;
    })
    .filter((x): x is { relDir: string; file: string; kind: string; path: string } => x !== undefined);

  const rootDoc = findMigrationDoc(root);
  const rootChangelogPath = rootDoc ? join(root, rootDoc.file) : undefined;
  const componentsDoc = pkgDir ? findMigrationDoc(pkgDir) : undefined;
  const componentsChangelogPath = pkgDir && componentsDoc ? join(pkgDir, componentsDoc.file) : undefined;
  const hasChangeset = existsSync(join(root, '.changeset'));
  const hasAnyChangelog = rootDoc !== undefined || componentsDoc !== undefined || workspaceChangelogs.length > 0;

  if (hasAnyChangelog || hasChangeset) {
    score += 25; // presence credit — earned once, regardless of how many of the sources above qualify
  }

  // Machine-readable version-heading scan: the components package's own
  // changelog if it has one (that's the changelog an agent migrating THIS
  // system's components most needs), else whichever changelog was found
  // first (root, then workspace packages in stable relDir order).
  const scanPath = componentsDoc
    ? componentsChangelogPath
    : [rootChangelogPath, ...workspaceChangelogs.map((w) => w.path)].find((p): p is string => p !== undefined);
  const scanKind = componentsDoc?.kind ?? rootDoc?.kind ?? workspaceChangelogs[0]?.kind ?? 'changelog';

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
      findings.push({ severity: 'info', message: `${relLocation} present (${scanKind}) with ${versionHeadings.length} machine-readable version heading(s).` });
    } else {
      findings.push({ severity: 'warn', message: `${relLocation} present (${scanKind}) but has no "## <version>" headings an agent can parse for migration context.` });
    }
  } else if (hasChangeset) {
    findings.push({
      severity: 'info',
      message: 'No CHANGELOG/MIGRATION/UPGRADING markdown found anywhere, but a .changeset/ directory is present (earns changelog-infrastructure credit; run changeset\'s version step to render it into an agent-readable CHANGELOG.md).',
    });
  } else {
    findings.push({
      severity: 'warn',
      message: 'No CHANGELOG*.md, MIGRATION*.md or UPGRADING*.md at the system root, the components package dir, or any workspace package.',
      fix: 'A machine-readable changelog or migration guide is a Tier-1 migration eval prerequisite.',
    });
  }

  if (workspaceChangelogs.length > 0) {
    findings.push({
      severity: 'info',
      message: `${workspaceChangelogs.length} workspace package(s) carry their own migration docs (e.g. ${workspaceChangelogs[0].relDir}/${workspaceChangelogs[0].file}).`,
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
