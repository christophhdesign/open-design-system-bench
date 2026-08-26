// Tier-0 check 5: Token machine-readability. Combines the extracted
// SystemTokens snapshot (flat cssVars/utilities name lists — see
// src/extract/tokens.ts) with a direct read of the raw foundationsCss file,
// because the snapshot doesn't retain *values*, and two of the four signals
// this check reports need them: whether a var's value references another
// var (semantic layer over primitives) and whether light/dark theming
// signals are present. DTCG (W3C design-tokens-format) JSON files are
// detected independently of both, by filename + a `"$value"` text probe.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokensPath } from '../../config.ts';
import type { SystemConfig, SystemId, SystemTokens } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { walkFiles } from '../fs-walk.ts';
import { readJsonSafe, round1, clamp } from '../util.ts';

const CSS_VAR_DECL_RE = /^\s*(--[\w-]+)\s*:\s*(.+?);?\s*$/;
const DARK_SIGNAL_RE = /prefers-color-scheme\s*:\s*dark|\[data-theme\s*=|data-theme=["']dark["']/i;

interface CssScan {
  varCount: number;
  semanticCount: number;
  hasDarkSignal: boolean;
}

function scanFoundationsCss(cssPath: string): CssScan | undefined {
  let content: string;
  try {
    content = readFileSync(cssPath, 'utf8');
  } catch {
    return undefined;
  }
  let varCount = 0;
  let semanticCount = 0;
  for (const line of content.split(/\r?\n/)) {
    const m = CSS_VAR_DECL_RE.exec(line);
    if (!m) continue;
    varCount += 1;
    if (/var\(--/.test(m[2])) semanticCount += 1;
  }
  return { varCount, semanticCount, hasDarkSignal: DARK_SIGNAL_RE.test(content) };
}

function findDtcgFiles(root: string): string[] {
  const files = walkFiles(root, { extensions: ['.tokens.json', 'tokens.json'] });
  const hits: string[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f.absPath, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('"$value"')) hits.push(f.relPath);
  }
  return hits;
}

export async function checkTokens(system: SystemId, cfg: SystemConfig, dirs: AuditDirs): Promise<AuditCheckResult> {
  const findings: AuditFinding[] = [];
  let score = 0;

  let varCount = 0;
  let cssScan: CssScan | undefined;

  if (cfg.foundationsCss) {
    cssScan = scanFoundationsCss(join(cfg.root, cfg.foundationsCss));
  }
  if (cssScan) {
    varCount = cssScan.varCount;
  } else {
    // No foundationsCss configured, or unreadable — fall back to a
    // pre-extracted snapshot's flat cssVars count if one exists. Semantic
    // layer and light/dark signals stay unmeasured (values aren't in the
    // snapshot), so those two findings are reported as n/a below.
    const snapshotPath = tokensPath(system, dirs.tokensDir);
    if (existsSync(snapshotPath)) {
      const snapshot = readJsonSafe<SystemTokens>(snapshotPath);
      varCount = snapshot?.cssVars.length ?? 0;
    }
  }

  if (varCount === 0) {
    findings.push({
      severity: 'fail',
      message: cfg.foundationsCss
        ? `No CSS custom properties found in ${cfg.foundationsCss}.`
        : 'No foundationsCss configured and no extracted tokens snapshot found.',
    });
  } else {
    findings.push({ severity: 'info', message: `${varCount} CSS custom propert${varCount === 1 ? 'y' : 'ies'} found.` });
    // Presence + a size signal: count alone caps at 40, min(count/30,1) so a
    // ~30-var foundation already gets full credit here (there are diminishing
    // returns to raw count once a system has a real token set).
    score += 10 + Math.min(varCount / 30, 1) * 30;
  }

  if (cssScan) {
    const semanticRatio = cssScan.varCount > 0 ? cssScan.semanticCount / cssScan.varCount : 0;
    findings.push({
      severity: semanticRatio < 0.2 ? 'warn' : 'info',
      message: `${cssScan.semanticCount}/${cssScan.varCount} vars (${round1(semanticRatio * 100)}%) reference another var: a semantic layer over primitives.`,
      fix: semanticRatio < 0.2 ? 'A flat token list without a semantic layer forces agents to pick raw values instead of intent-named ones.' : undefined,
    });
    score += semanticRatio * 30;

    if (cssScan.hasDarkSignal) {
      score += 15;
      findings.push({ severity: 'info', message: 'Light/dark theming signal found (prefers-color-scheme or [data-theme]).' });
    } else {
      findings.push({ severity: 'warn', message: 'No light/dark theming signal found in foundationsCss.' });
    }
  } else if (varCount > 0) {
    findings.push({ severity: 'info', message: 'Semantic-layer ratio and light/dark signal are unmeasured (no readable foundationsCss).' });
  }

  const dtcgFiles = findDtcgFiles(cfg.root);
  if (dtcgFiles.length > 0) {
    score += 15;
    findings.push({ severity: 'info', message: `${dtcgFiles.length} DTCG-shaped token file(s) found: ${dtcgFiles.slice(0, 5).join(', ')}${dtcgFiles.length > 5 ? ', …' : ''}.` });
  } else {
    findings.push({ severity: 'info', message: 'No DTCG (*.tokens.json / tokens.json with "$value") files found.' });
  }

  return { id: 'tokens', title: 'Token machine-readability', score: round1(clamp(score, 0, 100)), findings };
}
