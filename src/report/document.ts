// The report document: parsing a .report.md, and every gate `report --validate`
// applies to it.
//
// The contract this enforces is stated once, here: the data layer is fixed and
// the interpretation layer is free. Generated sections must byte-match a
// re-render, and every number in agent prose must be traceable. What the agent
// concludes from those numbers varies between authors, the way two human
// analysts vary, and nothing here constrains it.
//
// Report types live in this file rather than src/types.ts, following the
// precedent set by src/audit/types.ts.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { load } from 'js-yaml';
import type { JsonSchema } from './json-schema-lite.ts';
import { formatSchemaErrors, validateAgainstSchema } from './json-schema-lite.ts';
import type { FigureDerivation } from './figures.ts';
import { deriveFigure, describeDerivation } from './figures.ts';
import type { PriorFinding, ReportStats } from './stats.ts';
import { REPORT_OUTLINE, headingFor, renderStatsBlocks } from './stats.ts';
import type { RunResults, SystemCatalog } from '../types.ts';

// ---------------------------------------------------------------------------
// Types (mirror schema/report.schema.json, which is the source of truth)
// ---------------------------------------------------------------------------

export type FindingSeverity = 'defect' | 'gap' | 'divergence' | 'observation';
export type FindingStatus = 'open' | 'confirmed' | 'fixed' | 'wont-fix' | 'needs-triage';
export type FindingOwner = 'system' | 'harness' | 'tooling';

export type Evidence =
  | { kind: 'cell'; runId: string; cellKey: string; taskId: string; rep: number; dimension?: string; note?: string }
  | { kind: 'auditCheck'; checkId: string; note?: string }
  | { kind: 'file'; path: string; lines?: string; note?: string }
  | { kind: 'figure'; figureId: string; note?: string };

export interface Finding {
  id: string;
  title: string;
  severity: FindingSeverity;
  status: FindingStatus;
  owner: FindingOwner;
  section: string;
  evidence: Evidence[];
  recommendationIds?: string[];
}

export interface CitedFigure {
  id: string;
  value: number;
  source: string;
  method: string;
  derive?: FigureDerivation;
}

export interface ReportDocument {
  schemaVersion: 1;
  reportId: string;
  generatedAt: string;
  title: string;
  author: { kind: 'agent' | 'human'; model?: string; tool?: string };
  subject: {
    systemId: string;
    displayName: string;
    commit?: string | null;
    packages: Array<{ name: string; version?: string | null; role: 'components' | 'foundations' | 'other' }>;
  };
  harness: { version: string; repo?: string; commit?: string | null };
  provenance: {
    runs: Array<{
      runId: string;
      label?: string;
      profile: string;
      role: 'primary' | 'supporting';
      cellCount: number;
      startedAt?: string;
      finishedAt?: string;
    }>;
    catalog?: { components: number; exports: number; props: number; cssVars: number; utilities?: number };
  };
  methodology: {
    consume: 'source' | 'npm';
    contexts: string[];
    models: string[];
    agents: string[];
    reps: number;
    judge?: { model?: string; samples?: number };
    fixtureTemplate?: string;
    deviations: Array<{ change: string; rationale: string }>;
    comparabilityKey: string;
  };
  results: Record<string, unknown>;
  audit: Record<string, unknown>;
  citedFigures?: CitedFigure[];
  findings: Finding[];
  recommendations: Array<{ id: string; title: string; effort: string; breaking: boolean; findingIds: string[] }>;
  validityLimits: Array<{ id: string; text: string }>;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedReport {
  /** Raw parsed YAML. Not yet validated: pass through validateReport for that. */
  frontMatter: unknown;
  /** Everything after the closing `---`, with CRLF normalized to LF. */
  body: string;
  /** 1-based line number in the file where the body starts, so messages can point at it. */
  bodyStartLine: number;
}

export class ReportParseError extends Error {}

/**
 * Splits a .report.md into its YAML front matter and prose body.
 *
 * Front matter is required. A report without it is not a report this tool can
 * check, and silently treating one as valid would defeat the point.
 */
export function parseReportFrontMatter(markdown: string, filename: string): ParsedReport {
  const text = markdown.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    throw new ReportParseError(
      `[${filename}] no YAML front matter found. A report must open with a --- delimited block ` +
        `conforming to schema/report.schema.json. Run \`report --stats\` to generate the computed fields.`,
    );
  }

  let frontMatter: unknown;
  try {
    frontMatter = load(match[1]);
  } catch (err) {
    throw new ReportParseError(`[${filename}] front matter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (frontMatter === null || frontMatter === undefined) {
    throw new ReportParseError(`[${filename}] front matter is empty.`);
  }

  const bodyStartLine = text.slice(0, match[0].length).split('\n').length;
  return { frontMatter, body: text.slice(match[0].length), bodyStartLine };
}

interface FoundHeading {
  raw: string;
  level: number;
  lineIndex: number;
}

function findHeadings(body: string): FoundHeading[] {
  const lines = body.split('\n');
  const out: FoundHeading[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (m) out.push({ raw: m[2], level: m[1].length, lineIndex: i });
  });
  return out;
}

export interface SectionSlice {
  number: string;
  /** Body text between this outline heading and the next one, trimmed. */
  content: string;
  /** Headings found inside this section that are not themselves outline headings. */
  extraHeadings: string[];
}

/**
 * Locates each canonical outline section in the body. Agent sections may carry
 * their own sub-headings (5.1, 5.2, ...); generated sections may not.
 */
export function splitSections(body: string): { slices: Map<string, SectionSlice>; missing: string[]; outOfOrder: string[] } {
  const lines = body.split('\n');
  const headings = findHeadings(body);

  const anchors: Array<{ number: string; headingIndex: number }> = [];
  const missing: string[] = [];
  const outOfOrder: string[] = [];

  let cursor = 0;
  for (const section of REPORT_OUTLINE) {
    const want = headingFor(section).replace(/^#+\s+/, '');
    const idx = headings.findIndex((h, i) => i >= cursor && h.raw === want);
    if (idx === -1) {
      // Present but earlier than it should be: a reordering, not an omission.
      const anywhere = headings.findIndex((h) => h.raw === want);
      if (anywhere === -1) missing.push(headingFor(section));
      else outOfOrder.push(headingFor(section));
      continue;
    }
    anchors.push({ number: section.number, headingIndex: idx });
    cursor = idx + 1;
  }

  const slices = new Map<string, SectionSlice>();
  anchors.forEach((anchor, i) => {
    const startLine = headings[anchor.headingIndex].lineIndex + 1;
    const endLine = i + 1 < anchors.length ? headings[anchors[i + 1].headingIndex].lineIndex : lines.length;
    const content = lines.slice(startLine, endLine).join('\n').trim();
    const extraHeadings = headings
      .filter((h, hi) => hi > anchor.headingIndex && (i + 1 >= anchors.length || hi < anchors[i + 1].headingIndex))
      .map((h) => h.raw);
    slices.set(anchor.number, { number: anchor.number, content, extraHeadings });
  });

  return { slices, missing, outOfOrder };
}

/** Reads a previous report's finding index, for `--stats --since`. */
export function parsePriorFindings(markdown: string, filename: string): PriorFinding[] {
  const { frontMatter } = parseReportFrontMatter(markdown, filename);
  const fm = frontMatter as Partial<ReportDocument>;
  if (!Array.isArray(fm.findings)) return [];
  return fm.findings.map((f) => ({
    id: String(f.id),
    title: String(f.title ?? ''),
    severity: String(f.severity ?? ''),
    status: String(f.status ?? ''),
  }));
}

// ---------------------------------------------------------------------------
// Numeric provenance
// ---------------------------------------------------------------------------

export interface NumberHit {
  value: number;
  line: number;
  context: string;
}

/**
 * Finds numbers in prose that constitute a claim.
 *
 * Deliberately blind to: fenced code and inline code (quoted source and tool
 * output), link targets, heading numbering, section references, ISO dates,
 * semver, commit hashes and run ids. Those are all either machine-produced or
 * navigational, and none of them is an assertion about a result.
 *
 * `sectionNumbers` carries the dotted heading numbers this document actually
 * uses, so a bare cross-reference ("see 5.1", "(5.4)") reads as navigation
 * rather than as a figure. Only dotted numbers qualify: a bare "9" is far more
 * likely to be a count than a pointer at section 9.
 */
export function scanProseNumbers(content: string, startLine: number, sectionNumbers: Set<string> = new Set()): NumberHit[] {
  const hits: NumberHit[] = [];
  const lines = content.split('\n');
  let inFence = false;

  lines.forEach((rawLine, i) => {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    let line = rawLine;
    line = line.replace(/`[^`]*`/g, ' ');                       // inline code
    line = line.replace(/\]\([^)]*\)/g, '] ');                  // link targets
    line = line.replace(/^#{1,6}\s+[\dA-Z]+(?:\.\d+)*\.?\s*/, ''); // heading numbering
    line = line.replace(/^\s*\d+[.)]\s+/, ' ');                 // ordered-list markers
    line = line.replace(/§\s*\d+(?:\.\d+)*/g, ' ');             // section references
    line = line.replace(/\bsections?\s+\d+(?:\.\d+)*/gi, ' ');  // "section 5.1"
    line = line.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');         // ISO dates
    line = line.replace(/\b\d{8}-\d{6}\S*/g, ' ');              // run ids
    line = line.replace(/\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g, ' '); // semver
    line = line.replace(/\b[0-9a-f]{7,40}\b/g, (m) => (/[a-f]/.test(m) ? ' ' : m)); // commit hashes, not digit runs
    line = line.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (m) => m.replace(/,/g, '')); // thousands separators

    for (const m of line.matchAll(/(?<![\w.])[-−]?\d+(?:\.\d+)?(?![\w])/g)) {
      const raw = m[0].replace('−', '-');
      if (raw.includes('.') && sectionNumbers.has(raw)) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      hits.push({ value, line: startLine + i, context: rawLine.trim() });
    }
  });

  return hits;
}

/** Scores match to 0.05; counts must be exact, which the same tolerance gives for integers. */
const NUMERIC_TOLERANCE = 0.05;

function isTraceable(value: number, allowed: number[], figures: number[]): boolean {
  // Sign matters: deltas enter allowedNumbers in both directions, so a negated
  // quote of a positive-only figure is a wrong claim, not a formatting choice.
  return (
    allowed.some((a) => Math.abs(a - value) <= NUMERIC_TOLERANCE) ||
    figures.some((f) => Math.abs(f - value) <= NUMERIC_TOLERANCE)
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface GateMessage {
  gate: string;
  message: string;
}

export interface ValidateResult {
  errors: GateMessage[];
  warnings: GateMessage[];
  /** True when the cited run was unavailable and the data gates were downgraded. */
  degraded: boolean;
}

export interface ValidateContext {
  stats: ReportStats;
  run: RunResults;
  generatedFrontMatter: Record<string, unknown>;
}

export interface ValidateInput {
  filename: string;
  markdown: string;
  schema: JsonSchema;
  /**
   * Null when the primary run directory no longer exists. Reports outlive runs,
   * so the data gates downgrade to warnings rather than failing a valid
   * historical report.
   */
  context: ValidateContext | null;
  /** Roots that a citedFigures `source` or file evidence path may be relative to. */
  sourceRoots: string[];
  /** Extracted catalog for the system, when present, so declared derivations can be recomputed. */
  catalog?: SystemCatalog | null;
  prior?: PriorFinding[] | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function validateReport(input: ValidateInput): ValidateResult {
  const errors: GateMessage[] = [];
  const warnings: GateMessage[] = [];
  const fail = (gate: string, message: string): void => void errors.push({ gate, message });
  const warn = (gate: string, message: string): void => void warnings.push({ gate, message });

  const parsed = parseReportFrontMatter(input.markdown, input.filename);

  // --- G1: schema -------------------------------------------------------
  const schemaErrors = validateAgainstSchema(parsed.frontMatter, input.schema);
  if (schemaErrors.length > 0) {
    for (const line of formatSchemaErrors(schemaErrors)) fail('G1 schema', line);
    // Everything downstream reads typed fields; without a valid shape the
    // remaining gates would report noise rather than problems.
    return { errors, warnings, degraded: input.context === null };
  }
  const doc = parsed.frontMatter as ReportDocument;

  // --- G2: outline ------------------------------------------------------
  const { slices, missing, outOfOrder } = splitSections(parsed.body);
  for (const h of missing) fail('G2 outline', `missing required heading: ${h}`);
  for (const h of outOfOrder) fail('G2 outline', `heading is out of order: ${h}`);

  const degraded = input.context === null;
  if (degraded) {
    warn(
      'G3/G4/G9/G10',
      'run data is not available, so generated-block, numeric-provenance, evidence and coverage ' +
        'gates were skipped. Structural validation only.',
    );
  }

  // --- G3: generated blocks byte-match ---------------------------------
  const blocks = input.context ? renderStatsBlocks(input.context.stats) : null;
  if (blocks) {
    for (const section of REPORT_OUTLINE) {
      if (section.source !== 'generated') continue;
      const slice = slices.get(section.number);
      if (!slice) continue; // already reported by G2
      const expected = blocks[section.number]?.trim() ?? '';
      if (slice.content !== expected) {
        fail(
          'G3 generated',
          `section ${section.number} (${section.title}) does not match the generated block. ` +
            `Re-run \`report --stats\` and paste it verbatim. ${describeBlockDiff(expected, slice.content)}`,
        );
      }
      if (slice.extraHeadings.length > 0) {
        fail('G3 generated', `section ${section.number} is generated and must not contain sub-headings (found: ${slice.extraHeadings.join(', ')})`);
      }
    }
  }

  // --- G4: numeric provenance ------------------------------------------
  const figures = doc.citedFigures ?? [];
  if (input.context) {
    const allowed = input.context.stats.allowedNumbers;
    const figureValues = figures.map((f) => f.value);
    const sectionNumbers = collectSectionNumbers(parsed.body, doc);
    for (const section of REPORT_OUTLINE) {
      if (section.source !== 'agent') continue;
      const slice = slices.get(section.number);
      if (!slice) continue;
      for (const hit of scanProseNumbers(slice.content, 1, sectionNumbers)) {
        if (isTraceable(hit.value, allowed, figureValues)) continue;
        fail(
          'G4 numbers',
          `section ${section.number}: ${hit.value} is not a computed value and has no citedFigures entry. ` +
            `Either it is wrong, or declare it with its source and method. Line: "${truncate(hit.context, 90)}"`,
        );
      }
    }
  }

  // --- G5: cited figures ------------------------------------------------
  const figureIds = new Set<string>();
  for (const fig of figures) {
    if (figureIds.has(fig.id)) fail('G5 figures', `duplicate citedFigures id "${fig.id}"`);
    figureIds.add(fig.id);

    if (!resolveUnderRoots(fig.source, input.sourceRoots)) {
      warn(
        'G5 figures',
        `citedFigures "${fig.id}" names source "${fig.source}", not found under ${input.sourceRoots.join(' or ')}. ` +
          'The system repo may simply not be checked out here.',
      );
    }

    if (!fig.derive) continue;
    const outcome = deriveFigure(fig.derive, { catalog: input.catalog ?? null });
    if (outcome.value === null) {
      warn('G5 figures', `citedFigures "${fig.id}" declares a derivation that could not be run: ${outcome.unavailable}`);
    } else if (outcome.value !== fig.value) {
      fail(
        'G5 figures',
        `citedFigures "${fig.id}" claims ${fig.value}, but recomputing ${describeDerivation(fig.derive)} ` +
          `from the extracted catalog gives ${outcome.value}.`,
      );
    }
  }

  // --- G6: ids ----------------------------------------------------------
  const findingIds = new Set<string>();
  for (const f of doc.findings) {
    if (findingIds.has(f.id)) fail('G6 ids', `duplicate finding id "${f.id}"`);
    findingIds.add(f.id);
    if (!SLUG.test(f.id)) fail('G6 ids', `finding id "${f.id}" must be kebab-case`);
  }
  const recIds = new Set<string>();
  for (const r of doc.recommendations) {
    if (recIds.has(r.id)) fail('G6 ids', `duplicate recommendation id "${r.id}"`);
    recIds.add(r.id);
  }

  // --- G7: evidence present --------------------------------------------
  for (const f of doc.findings) {
    if (f.evidence.length === 0) fail('G7 evidence', `finding "${f.id}" has no evidence`);
  }

  // --- G8: cross-references --------------------------------------------
  for (const f of doc.findings) {
    for (const id of f.recommendationIds ?? []) {
      if (!recIds.has(id)) fail('G8 refs', `finding "${f.id}" references unknown recommendation "${id}"`);
    }
  }
  for (const r of doc.recommendations) {
    for (const id of r.findingIds) {
      if (!findingIds.has(id)) fail('G8 refs', `recommendation "${r.id}" references unknown finding "${id}"`);
    }
  }
  for (const f of doc.findings) {
    for (const e of f.evidence) {
      if (e.kind === 'figure' && !figureIds.has(e.figureId)) {
        fail('G8 refs', `finding "${f.id}" cites figure "${e.figureId}", which is not declared in citedFigures`);
      }
    }
  }

  // --- G9: evidence grounding ------------------------------------------
  const runIds = new Set(doc.provenance.runs.map((r) => r.runId));
  const primaries = doc.provenance.runs.filter((r) => r.role === 'primary');
  if (primaries.length !== 1) {
    fail('G9 evidence', `exactly one run must have role "primary" (found ${primaries.length})`);
  }
  for (const f of doc.findings) {
    for (const e of f.evidence) {
      if (e.kind === 'cell') {
        if (!runIds.has(e.runId)) {
          fail('G9 evidence', `finding "${f.id}" cites run "${e.runId}", which is not listed in provenance.runs`);
          continue;
        }
        if (!input.context) continue;
        const cell = input.context.stats.cells.find(
          (c) => c.cellKey === e.cellKey && c.taskId === e.taskId && c.rep === e.rep,
        );
        if (!cell) {
          fail('G9 evidence', `finding "${f.id}" cites ${e.cellKey}/${e.taskId}/rep${e.rep}, which is not in run ${e.runId}`);
          continue;
        }
        if (e.dimension && !(e.dimension in cell.dimensions)) {
          fail('G9 evidence', `finding "${f.id}" cites dimension "${e.dimension}" on ${e.taskId}, which that cell has no score for`);
        }
      } else if (e.kind === 'auditCheck') {
        if (!input.context) continue;
        const known = input.context.stats.auditChecks.some((c) => c.id === e.checkId);
        if (!known) {
          fail('G9 evidence', `finding "${f.id}" cites audit check "${e.checkId}", which is not a check this harness runs`);
        }
      } else if (e.kind === 'file') {
        if (!resolveUnderRoots(e.path, input.sourceRoots)) {
          warn('G9 evidence', `finding "${f.id}" cites file "${e.path}", not found under ${input.sourceRoots.join(' or ')}`);
        }
      }
    }
  }

  // --- G10: coverage ----------------------------------------------------
  if (input.context) {
    for (const item of input.context.stats.coverage) {
      const covered = doc.findings.some((f) => f.evidence.some((e) => evidenceSatisfies(e, item.match)));
      if (!covered) {
        fail('G10 coverage', `nothing addresses: ${item.label} [${item.key}]`);
      }
    }
  }

  // --- G11: no unresolved triage ---------------------------------------
  for (const f of doc.findings) {
    if (f.status === 'needs-triage') {
      fail('G11 triage', `finding "${f.id}" is still needs-triage. Resolve it: write it up, or drop it.`);
    }
  }

  // --- G12: carried-forward ids ----------------------------------------
  if (input.prior) {
    for (const p of input.prior) {
      const current = doc.findings.find((f) => f.id === p.id);
      if (!current) {
        warn('G12 history', `finding "${p.id}" was in the previous report and is absent here. If it is resolved, carry it forward with status fixed or wont-fix rather than dropping it.`);
      }
    }
  }

  // --- G13: findings point at real sections ----------------------------
  for (const f of doc.findings) {
    const hasHeading = parsed.body.split('\n').some((l) => new RegExp(`^#{2,6}\\s+${escapeRegExp(f.section)}[.\\s]`).test(l));
    if (!hasHeading) {
      warn('G13 sections', `finding "${f.id}" points at section ${f.section}, which has no heading in the body`);
    }
  }

  // --- G14: house style -------------------------------------------------
  const styleIssues = new Set<string>();
  for (const section of REPORT_OUTLINE) {
    if (section.source !== 'agent') continue;
    const slice = slices.get(section.number);
    if (!slice) continue;
    if (/—/.test(slice.content)) styleIssues.add('em dashes');
    if (/[‘’“”]/.test(slice.content)) styleIssues.add('curly quotes');
  }
  for (const issue of styleIssues) {
    warn('G14 style', `prose contains ${issue}. AGENTS.md asks for straight quotes and no em dashes in docs and reports.`);
  }

  return { errors, warnings, degraded };
}

/**
 * Every dotted heading number the document uses, plus the sections its findings
 * point at, so cross-references are recognised as navigation.
 */
function collectSectionNumbers(body: string, doc: ReportDocument): Set<string> {
  const out = new Set<string>();
  for (const section of REPORT_OUTLINE) out.add(section.number);
  for (const line of body.split('\n')) {
    const m = /^#{2,6}\s+(\d+(?:\.\d+)+)/.exec(line);
    if (m) out.add(m[1]);
  }
  for (const f of doc.findings) out.add(f.section);
  return out;
}

function evidenceSatisfies(e: Evidence, match: { kind: string; [k: string]: unknown }): boolean {
  if (match.kind === 'cell' && e.kind === 'cell') {
    return e.cellKey === match.cellKey && e.taskId === match.taskId && e.rep === match.rep;
  }
  if (match.kind === 'dimension' && e.kind === 'cell') {
    return e.dimension === match.dimension;
  }
  if (match.kind === 'auditCheck' && e.kind === 'auditCheck') {
    return e.checkId === match.checkId;
  }
  return false;
}

function resolveUnderRoots(p: string, roots: string[]): string | null {
  if (isAbsolute(p)) return existsSync(p) ? p : null;
  for (const root of roots) {
    const candidate = join(root, p);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

/** Points at the first differing line rather than dumping two blocks at the author. */
function describeBlockDiff(expected: string, actual: string): string {
  const e = expected.split('\n');
  const a = actual.split('\n');
  for (let i = 0; i < Math.max(e.length, a.length); i += 1) {
    if (e[i] !== a[i]) {
      if (e[i] === undefined) return `First difference at line ${i + 1}: unexpected extra line "${truncate(a[i], 70)}".`;
      if (a[i] === undefined) return `First difference at line ${i + 1}: missing line "${truncate(e[i], 70)}".`;
      return `First difference at line ${i + 1}: expected "${truncate(e[i], 70)}", found "${truncate(a[i], 70)}".`;
    }
  }
  return '';
}

/** Loads schema/report.schema.json. */
export function loadReportSchema(schemaPath: string): JsonSchema {
  return JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchema;
}
