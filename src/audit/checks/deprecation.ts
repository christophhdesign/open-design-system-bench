// Tier-0 check 6: Deprecation legibility. "Agents migrate what they can
// read" — three independent, additive signals: @deprecated JSDoc in the
// component source (machine-parseable, unlike a wiki page), a CHANGELOG.md
// with a machine-readable version-heading structure, and a codemods
// directory hint. None of these can be scored as "good" purely from a count
// (zero @deprecated tags might mean nothing is deprecated, or might mean
// deprecations exist and aren't annotated — a static audit can't tell the
// difference), so this check reports presence, not a hallucination-style
// error count.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SystemConfig, SystemId } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { walkFiles } from '../fs-walk.ts';
import { readJsonSafe, round1, clamp, findPackageDir } from '../util.ts';

const DEPRECATED_RE = /@deprecated\b/g;
const VERSION_HEADING_RE = /^##\s+\[?v?\d+\.\d+\.\d+/gm;

interface PkgJson {
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

  // --- CHANGELOG.md (40: 25 presence + 15 machine-readable structure) ---
  // Checked at both the system root and the components package dir: in a
  // monorepo the changelog commonly
  // lives per-package rather than at the repo root, so both are checked.
  // packages/components/CHANGELOG.md with none at root at all.
  const pkgDir = findPackageDir(join(root, cfg.componentsSrc), root);
  const changelogCandidates = [join(root, 'CHANGELOG.md'), ...(pkgDir ? [join(pkgDir, 'CHANGELOG.md')] : [])];
  const changelogPath = changelogCandidates.find((p) => existsSync(p));
  if (changelogPath) {
    score += 25;
    let content = '';
    try {
      content = readFileSync(changelogPath, 'utf8');
    } catch {
      // presence already credited
    }
    const relLocation = changelogPath.startsWith(root) ? changelogPath.slice(root.length + 1) : changelogPath;
    const versionHeadings = content.match(VERSION_HEADING_RE) ?? [];
    if (versionHeadings.length > 0) {
      score += 15;
      findings.push({ severity: 'info', message: `${relLocation} present with ${versionHeadings.length} machine-readable version heading(s).` });
    } else {
      findings.push({ severity: 'warn', message: `${relLocation} present but has no "## <version>" headings an agent can parse for migration context.` });
    }
  } else {
    findings.push({ severity: 'warn', message: 'No CHANGELOG.md at the system root or the components package dir.', fix: 'A machine-readable changelog is a Tier-1 migration eval prerequisite.' });
  }

  // --- codemods hint (25) ---
  const codemodDirs = ['codemods', join('scripts', 'codemods')];
  const hasCodemodDir = codemodDirs.some((d) => existsSync(join(root, d)));
  const pkg = readJsonSafe<PkgJson>(join(root, 'package.json'));
  const hasCodemodScript = Object.values(pkg?.scripts ?? {}).some((v) => /codemod/i.test(v)) || Object.keys(pkg?.scripts ?? {}).some((k) => /codemod/i.test(k));
  if (hasCodemodDir || hasCodemodScript) {
    score += 25;
    findings.push({ severity: 'info', message: 'Codemods hint found (codemods/ dir or a codemod script).' });
  } else {
    findings.push({ severity: 'info', message: 'No codemods hint found.' });
  }

  return { id: 'deprecation', title: 'Deprecation legibility', score: round1(clamp(score, 0, 100)), findings };
}
