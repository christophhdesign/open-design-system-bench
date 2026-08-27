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

// Light/dark theming signal: four independent patterns, any one of which is
// sufficient. Kept as separate named regexes (rather than one giant
// alternation) so each one's intent, and its anti-false-positive anchoring,
// stays legible on its own.
//
// 1. The standard media-query form.
const PREFERS_COLOR_SCHEME_DARK_RE = /prefers-color-scheme\s*:\s*dark/i;
// 2. Any `data-*theme` or `data-*color-scheme`/`color-mode` attribute, as an
//    attribute selector ([data-theme=...], [data-mantine-color-scheme=...])
//    or a plain HTML/JSX attribute. Design systems invent their own prefix
//    (Mantine's is "data-mantine-color-scheme"), so the infix is a wildcard;
//    the trailing \b keeps "data-athemepark" (no hyphen before "theme") from
//    matching.
const DATA_THEME_ATTR_RE = /data-(?:[a-z0-9]+-)*(?:theme|color-scheme|color-mode)\b/i;
// 3. A standalone `.dark` class selector, anchored to CSS selector syntax
//    (whitespace, `{`, `,`, or a combinator immediately after) so it matches
//    `.dark {` / `html.dark .x` / `.dark, .x` but not `.darker` or prose
//    that merely contains the word "dark".
const DARK_CLASS_SELECTOR_RE = /\.dark(?=[\s{,>+~]|$)/;
// 4. The `color-scheme` CSS property/declaration itself (e.g. `color-scheme:
//    light dark;`), which is a browser-native dark-mode signal independent
//    of any custom attribute or media query.
const COLOR_SCHEME_DECL_RE = /color-scheme\s*:/i;

/** True if `css` contains any recognized light/dark theming signal. Exported for unit testing. */
export function hasDarkSignal(css: string): boolean {
  return (
    PREFERS_COLOR_SCHEME_DARK_RE.test(css) ||
    DATA_THEME_ATTR_RE.test(css) ||
    DARK_CLASS_SELECTOR_RE.test(css) ||
    COLOR_SCHEME_DECL_RE.test(css)
  );
}

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
  return { varCount, semanticCount, hasDarkSignal: hasDarkSignal(content) };
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
      findings.push({ severity: 'info', message: 'Light/dark theming signal found (prefers-color-scheme, a data-*theme/color-scheme attribute, a .dark class selector, or a color-scheme declaration).' });
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
