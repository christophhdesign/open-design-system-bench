// Tier-0 check 5: Token machine-readability. Combines the extracted
// SystemTokens snapshot (flat cssVars/utilities name lists — see
// src/extract/tokens.ts) with a direct read of the raw foundationsCss file,
// because the snapshot doesn't retain *values*, and two of the four signals
// this check reports need them: whether a var's value references another
// var (semantic layer over primitives) and whether light/dark theming
// signals are present. DTCG (W3C design-tokens-format) JSON files are
// detected independently of both, by filename + a `"$value"` text probe.
//
// Field-test finding (plan items 3.5 + 5.3): several production systems have
// a *real* token system that this check's zero path cannot see, because it
// only reads a compiled CSS file or an already-extracted snapshot. Carbon
// keeps its ~164 `--cds-*` custom properties in .scss sources that only
// become CSS after a Sass build; Chakra/MUI/Ant Design define a full
// semantic token system as TypeScript objects (`defineTokens`,
// `defineSemanticTokens`, `createTheme`) rather than CSS. Scoring those
// systems an outright 0 — the same as a system with no tokens at all — is
// wrong: the tokens exist and are legible to a human, just not to static
// tooling without a build step or a language-aware parser. The blocks below
// award reduced, clearly-labeled PARTIAL credit for exactly that "detectable
// but not machine-readable" situation, gated so they only ever fire on the
// path that would otherwise be a flat fail (see the zero-path gate in
// checkTokens). Full-credit paths (compiled CSS custom properties, DTCG
// JSON) are untouched.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describeFoundationsCss, readFoundationsCss, tokensPath } from '../../config.ts';
import type { SystemConfig, SystemId, SystemTokens } from '../../types.ts';
import type { AuditCheckResult, AuditDirs, AuditFinding } from '../types.ts';
import { walkFiles } from '../fs-walk.ts';
import { readJsonSafe, round1, clamp } from '../util.ts';

const CSS_VAR_DECL_RE = /^\s*(--[\w-]+)\s*:\s*(.+?);?\s*$/;

// SCSS pre-build tokens: a declaration line, same shape as CSS_VAR_DECL_RE's
// left-hand side but without requiring a value capture (we only need to
// count, not evaluate) — SCSS declarations may use functions/interpolation
// that CSS_VAR_DECL_RE's value pattern isn't meant to handle.
const SCSS_VAR_DECL_RE = /^\s*--[\w-]+\s*:/;
// Below this many custom-property declarations across all .scss sources,
// it's not clearly "a token system", just a stray CSS variable or two.
const MIN_SCSS_VAR_DECLS = 10;

// TS-defined token system markers. Deliberately narrow: the two Chakra v3
// APIs that construct a token layer, plus MUI/Ant Design's `createTheme`.
// `defineConfig({ theme: ... })` was considered and rejected — a bare
// `theme` key is too generic a marker and would false-positive on unrelated
// config objects.
// Helper calls (Panda/Chakra/vanilla-extract style) OR a semanticTokens
// object being declared/assigned: Chakra keeps its define* calls in a
// sibling preset package, but its react package still declares
// `export const semanticTokens = {...}` in theme sources, which is the same
// signal (a TS-defined semantic token layer) without the helper.
const TS_TOKEN_MARKER_RE = /\b(?:defineTokens|defineSemanticTokens|createTheme)\s*\(|\bsemanticTokens\s*[:=]/;

// Partial-credit point values. Chosen to mirror the weights the full
// CSS-scan path already uses for the same underlying signal (a "the tokens
// are there" base, and the same +15 for a dark-mode signal), so the two
// paths stay legible side by side, while the combined cap below keeps
// partial credit strictly under what a real machine-readable token file
// with a semantic layer and dark-mode support earns.
const SCSS_DETECTED_SCORE = 20;
const TS_DETECTED_SCORE = 20;
const SCSS_DARK_SIGNAL_SCORE = 15;
// Combined ceiling for the SCSS + TS partial-credit paths. Detectable is not
// machine-readable: even a system that hits both signals stays capped well
// below what a compiled CSS file with a semantic layer and dark support
// scores (see the "full CSS scan" branch below), because none of this is
// actually parseable by static tooling without a build step or a
// language-aware parser.
const PARTIAL_CREDIT_CAP = 45;

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

/**
 * Scans the system's configured foundations CSS. `foundationsCss` may name one
 * file or several (a per-category token set with no aggregate entry point);
 * readFoundationsCss concatenates them, so the counts here are the union and
 * the light/dark signal is found wherever it lives. Returns undefined when
 * nothing is configured or not one listed file could be read — the caller
 * falls back to the extracted snapshot and, failing that, partial credit.
 */
function scanFoundationsCss(cfg: SystemConfig): CssScan | undefined {
  const css = readFoundationsCss(cfg);
  if (!css || css.read.length === 0) return undefined;
  const content = css.content;
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

interface ScssScan {
  totalDecls: number;
  densestFile?: { relPath: string; count: number };
  /** Concatenated content of every .scss file scanned, so hasDarkSignal can run over it once. */
  concatenated: string;
}

/** Walks the repo for .scss files and counts CSS-custom-property declaration lines — the Carbon-style "tokens exist, but only pre-Sass-build" shape. */
function scanScssFiles(root: string): ScssScan {
  const files = walkFiles(root, { extensions: ['.scss'] });
  let totalDecls = 0;
  let densestFile: { relPath: string; count: number } | undefined;
  const chunks: string[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f.absPath, 'utf8');
    } catch {
      continue;
    }
    chunks.push(content);
    let count = 0;
    for (const line of content.split(/\r?\n/)) {
      if (SCSS_VAR_DECL_RE.test(line)) count += 1;
    }
    totalDecls += count;
    if (count > 0 && (!densestFile || count > densestFile.count)) {
      densestFile = { relPath: f.relPath, count };
    }
  }
  return { totalDecls, densestFile, concatenated: chunks.join('\n') };
}

/**
 * Searches for a TS/TSX file that constructs a token system via
 * defineTokens/defineSemanticTokens/createTheme. Scoped to componentsSrc's
 * parent directory rather than the whole repo: that one hop up already
 * covers componentsSrc itself plus sibling dirs design systems commonly use
 * for theme/token code (e.g. a `theme/` or `styled-system/` next to `src/`),
 * without walking unrelated parts of a monorepo.
 */
function findTsTokenFile(cfg: SystemConfig): string | undefined {
  const componentsSrcAbs = join(cfg.root, cfg.componentsSrc);
  const searchRoot = dirname(componentsSrcAbs);
  const files = walkFiles(searchRoot, { extensions: ['.ts', '.tsx'] });
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f.absPath, 'utf8');
    } catch {
      continue;
    }
    if (TS_TOKEN_MARKER_RE.test(content)) return relative(cfg.root, f.absPath);
  }
  return undefined;
}

/**
 * Zero-path partial credit (plan 3.5 + 5.3). Only ever called when there is
 * no usable foundationsCss scan and no snapshot cssVars — i.e. the branch
 * that would otherwise fall straight to the "no CSS custom properties" fail
 * finding. Pushes its own info findings and returns the (capped) score to
 * add; returns 0 and pushes nothing when neither signal is found, leaving
 * the caller free to push the unchanged fail finding.
 */
function addZeroPathPartialCredit(cfg: SystemConfig, findings: AuditFinding[]): number {
  const scssScan = scanScssFiles(cfg.root);
  const scssHit = scssScan.totalDecls >= MIN_SCSS_VAR_DECLS;
  const tsTokenFile = findTsTokenFile(cfg);

  if (!scssHit && !tsTokenFile) return 0;

  let partialScore = 0;

  if (scssHit) {
    partialScore += SCSS_DETECTED_SCORE;
    findings.push({
      severity: 'info',
      message: `${scssScan.totalDecls} CSS custom property declarations found in .scss sources (pre-build — not statically machine-readable until compiled)${
        scssScan.densestFile ? `; densest file: ${scssScan.densestFile.relPath} (${scssScan.densestFile.count})` : ''
      }.`,
      fix: 'Compile the token layer to a shipped .css (or DTCG JSON) so tokens are machine-readable without a Sass build.',
    });
    if (hasDarkSignal(scssScan.concatenated)) {
      partialScore += SCSS_DARK_SIGNAL_SCORE;
      findings.push({
        severity: 'info',
        message: 'Light/dark theming signal found in .scss sources (prefers-color-scheme, a data-*theme/color-scheme attribute, a .dark class selector, or a color-scheme declaration).',
      });
    }
  }

  if (tsTokenFile) {
    partialScore += TS_DETECTED_SCORE;
    findings.push({
      severity: 'info',
      message: `TS-defined token system found in ${tsTokenFile} (defineTokens/defineSemanticTokens/createTheme).`,
      fix: 'Export the token layer as DTCG JSON (or compiled CSS custom properties): TS token objects are invisible to static tooling.',
    });
  }

  return Math.min(partialScore, PARTIAL_CREDIT_CAP);
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
    cssScan = scanFoundationsCss(cfg);
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
    // Zero path: no usable foundationsCss scan (cssScan undefined) and no
    // snapshot cssVars. Before settling on a flat fail, check for a
    // detectable-but-not-machine-readable token system (SCSS pre-build
    // tokens, or a TS-defined token system) and award partial credit for it.
    const partialScore = cssScan ? 0 : addZeroPathPartialCredit(cfg, findings);
    if (partialScore > 0) {
      score += partialScore;
    } else {
      findings.push({
        severity: 'fail',
        message: cfg.foundationsCss
          ? `No CSS custom properties found in ${describeFoundationsCss(cfg)}.`
          : 'No foundationsCss configured and no extracted tokens snapshot found.',
      });
    }
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
