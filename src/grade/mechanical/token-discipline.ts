// Dimension: tokenDiscipline (weight .15)
// Flags raw hex/rgb colors and raw px/rem dimensions that bypass the design
// system's tokens — in className strings (including Tailwind arbitrary-value
// syntax) and in inline style object literals. Deliberately does NOT try to
// validate every utility class against the token list; core Tailwind spacing
// utilities (p-4, gap-2, ...) are legitimate and out of scope here.

import { matchesGlob } from 'node:path';
import type { DimensionResult, Diff, Gate } from '../../types.ts';
import type { GradeContext } from '../context.ts';

type ViolationKind = 'color' | 'dimension';

const HEX_COLOR_RE = /#[0-9a-fA-F]{3,8}\b/;
const RGB_FUNC_RE = /\brgba?\([^)]*\)/i;
const RAW_DIMENSION_RE = /\d(px|rem)\b/i;
const BRACKET_RE = /\[[^\]]+\]/g;

function classifyText(text: string): ViolationKind | null {
  if (HEX_COLOR_RE.test(text) || RGB_FUNC_RE.test(text)) return 'color';
  if (RAW_DIMENSION_RE.test(text)) return 'dimension';
  return null;
}

// A tiny glob->regex fallback in case node:path's matchesGlob is ever
// unavailable at runtime despite being present in the type declarations.
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split('')
    .map((ch) => (/[.+^${}()|\\]/.test(ch) ? `\\${ch}` : ch))
    .join('')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  for (const glob of globs) {
    try {
      if (matchesGlob(filePath, glob)) return true;
    } catch {
      if (globToRegExp(glob).test(filePath)) return true;
    }
  }
  return false;
}

interface Finding {
  kind: ViolationKind;
  message: string;
  fix?: string;
}

function findClassNameViolations(value: string, line: number, filePath: string): Finding[] {
  const findings: Finding[] = [];
  let masked = value;

  // (b) Tailwind arbitrary values: bg-[#ff0000], w-[137px], text-[13px]...
  for (const match of value.matchAll(BRACKET_RE)) {
    const inner = match[0];
    const kind = classifyText(inner);
    if (kind) {
      findings.push({
        kind,
        message: `Arbitrary Tailwind value '${inner}' in ${filePath}:${line} bypasses design tokens`,
        fix: kind === 'color' ? 'Use a design system color token/utility instead of a raw hex/rgb value.' : 'Use a design system spacing/sizing token instead of a raw px/rem value.',
      });
    }
    // Blank out this span so it isn't double-counted as a bare hex below.
    masked = masked.replace(inner, ' '.repeat(inner.length));
  }

  // (a) Bare hex/rgb colors outside of any arbitrary-value bracket.
  const hexMatch = HEX_COLOR_RE.exec(masked);
  if (hexMatch) {
    findings.push({
      kind: 'color',
      message: `Raw hex color '${hexMatch[0]}' in ${filePath}:${line} bypasses design tokens`,
      fix: 'Use a design system color token/utility instead of a raw hex value.',
    });
  }
  const rgbMatch = RGB_FUNC_RE.exec(masked);
  if (rgbMatch) {
    findings.push({
      kind: 'color',
      message: `Raw color function '${rgbMatch[0]}' in ${filePath}:${line} bypasses design tokens`,
      fix: 'Use a design system color token/utility instead of a raw rgb()/rgba() value.',
    });
  }

  return findings;
}

function findInlineStyleViolation(prop: string, value: string, line: number, filePath: string): Finding | undefined {
  const kind = classifyText(value);
  if (!kind) return undefined;
  return {
    kind,
    message: `Inline style ${prop}: '${value}' in ${filePath}:${line} bypasses design tokens`,
    fix:
      kind === 'color'
        ? `Use a design system color token instead of a raw value for '${prop}'.`
        : `Use a design system spacing/sizing token instead of a raw value for '${prop}'.`,
  };
}

export function gradeTokenDiscipline(ctx: GradeContext): DimensionResult {
  const diffs: Diff[] = [];
  let violations = 0;
  let anyColor = false;
  const allowHexIn = ctx.task.mechanicalOverrides?.allowHexIn ?? [];

  for (const file of ctx.files) {
    const hexAllowed = allowHexIn.length > 0 && matchesAnyGlob(file.path, allowHexIn);

    for (const cls of file.analysis.classNameLiterals) {
      for (const finding of findClassNameViolations(cls.value, cls.line, file.path)) {
        if (hexAllowed && finding.kind === 'color') continue;
        violations += 1;
        if (finding.kind === 'color') anyColor = true;
        diffs.push({ dimension: 'tokenDiscipline', message: finding.message, fix: finding.fix });
      }
    }

    for (const style of file.analysis.inlineStyles) {
      const finding = findInlineStyleViolation(style.prop, style.value, style.line, file.path);
      if (!finding) continue;
      if (hexAllowed && finding.kind === 'color') continue;
      violations += 1;
      if (finding.kind === 'color') anyColor = true;
      diffs.push({ dimension: 'tokenDiscipline', message: finding.message, fix: finding.fix });
    }
  }

  const score = Math.max(0, 100 - violations * 10);
  let gate: Gate;
  if (violations === 0) gate = 'pass';
  else if (violations > 3) gate = 'review';
  else gate = anyColor ? 'review' : 'pass';

  return { dimension: 'tokenDiscipline', score, gate, diffs };
}
