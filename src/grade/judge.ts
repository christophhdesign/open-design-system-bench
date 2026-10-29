// LLM-as-judge grader. Runs the locally installed `claude` CLI headless,
// in structured-output mode, to grade a code-change artifact against a
// task's rubric. This module never talks to the Claude API directly — it
// shells out to `claude -p` so the judge model, auth, and rate limits are
// whatever the operator's `claude` install already has configured.

import { spawn } from 'node:child_process';
import { looksLikeUsageLimit, UsageLimitError } from '../agents/errors.ts';
import { loadBenchConfig } from '../config.ts';
import { chatComplete, resolveProvider } from '../providers/client.ts';
import { withheldRubrics } from '../tasks/affordances.ts';
import type {
  CatalogExport,
  Diff,
  DimensionResult,
  Gate,
  JudgeOutput,
  JudgeVerdict,
  SystemCatalog,
  SystemConfig,
  SystemId,
  Task,
  TaskRubric,
} from '../types.ts';

export interface JudgeRequest {
  task: Task;
  system: SystemId;
  catalog: SystemCatalog;
  diffPatch: string; // the artifact under judgment
  model: string; // e.g. 'haiku'
  timeoutMs: number;
  samples: number; // ≥1; >1 → majority vote / mean score
  /** Provider id (key into bench.config.json "providers"); unset or 'claude-cli' = the claude CLI judge (default). */
  provider?: string;
  /** The system's config, for its `affordances` names. Rubrics the system cannot be graded on are withheld. */
  systemCfg?: SystemConfig;
}

export interface JudgeResult {
  output: JudgeOutput; // aggregated
  rawSamples: JudgeOutput[];
  /** dimension:'judgment'. Absent when every rubric is withheld for this system: nothing was graded. */
  dimension?: DimensionResult;
  varianceNote?: string; // when samples>1 and verdicts disagreed
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Unified diffs beyond this length have their tail cut, per the truncation contract. */
const MAX_DIFF_CHARS = 60_000;

const TRUNCATION_MARKER = '\n[truncated]\n';

/**
 * JSON Schema for the judge's structured output, fed to `claude --json-schema`.
 * Mirrors the JudgeOutput/JudgeVerdict shapes in ../types.ts exactly — keep in sync.
 */
const JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rubricId: { type: 'string' },
          pass: { type: 'boolean' },
          score: { type: 'number', minimum: 0, maximum: 1 },
          reasoning: { type: 'string' },
        },
        required: ['rubricId', 'pass', 'score', 'reasoning'],
        additionalProperties: false,
      },
    },
    overallNotes: { type: 'string' },
  },
  required: ['verdicts', 'overallNotes'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildJudgeSystemPrompt(system: SystemId): string {
  return [
    `You are a strict design-system reviewer for the ${system} design system, evaluating a single code change against a fixed rubric.`,
    '',
    'Judge ONLY the rubric items you are given below, and judge each one as a behavioral requirement the code change either clearly does or does not satisfy — not as a matter of style preference.',
    '',
    'Be skeptical: mark a rubric item as passing only if the diff clearly and unambiguously satisfies it. If the evidence is ambiguous, partial, or you cannot verify the behavior from the diff, do not pass it.',
    '',
    'You are not given rubric weights or which items are "critical" — that information does not exist for you and must not be guessed at or mentioned.',
    '',
    'Respond only with the structured JSON the response schema requires. Do not use any tools.',
  ].join('\n');
}

function truncateDiff(diffPatch: string): string {
  if (diffPatch.length <= MAX_DIFF_CHARS) return diffPatch;
  return diffPatch.slice(0, MAX_DIFF_CHARS) + TRUNCATION_MARKER;
}

/**
 * Pulls named/default import identifiers out of added (`+`) lines of a unified
 * diff, including imports that span several lines (the usual shape once a
 * file imports more than a few components). Used to decide which catalog
 * components are "in play" for this change and to check the judge's import
 * claims. Callers filter against catalog.allExports where it matters, so
 * false positives (e.g. `import clsx from 'clsx'`) are harmless.
 */
function extractImportedIdentifiers(diffPatch: string): Set<string> {
  const ids = new Set<string>();
  const added = diffPatch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1))
    .join('\n');

  const namedImportRe = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s+['"][^'"]+['"]/g;
  let m: RegExpExecArray | null;
  while ((m = namedImportRe.exec(added))) {
    if (m[1]) ids.add(m[1]);
    for (const part of m[2]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/i)[0]?.trim();
      if (name) ids.add(name);
    }
  }

  const defaultImportRe = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/g;
  while ((m = defaultImportRe.exec(added))) {
    if (m[1]) ids.add(m[1]);
  }

  return ids;
}

function findCatalogExport(catalog: SystemCatalog, name: string): CatalogExport | undefined {
  for (const component of catalog.components) {
    const match = component.exports.find((e) => e.displayName === name);
    if (match) return match;
  }
  return undefined;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderPropsTable(exp: CatalogExport): string {
  const header = '| prop | type | required | default |\n| --- | --- | --- | --- |';
  const rows = exp.props.map((p) => {
    const def = p.defaultValue !== undefined ? escapeCell(p.defaultValue) : '';
    return `| ${escapeCell(p.name)} | ${escapeCell(p.type)} | ${p.required ? 'yes' : 'no'} | ${def} |`;
  });
  const desc = exp.description ? `${exp.description}\n\n` : '';
  return `#### ${exp.displayName}\n${desc}${header}\n${rows.join('\n')}`;
}

/**
 * "API reference" excerpt: props tables for every component name that shows
 * up in the diff's added import lines, plus every symbol the task's hidden
 * expectations allow for this system. Deduped, and always presented as
 * neutral reference material — never as a hint about the "right" answer.
 * hiddenExpectations is optional (a task authored against a stranger's
 * system can't know its component names in advance), so this excerpt is
 * simply omitted when it's absent — the judge falls back to what it can
 * infer from the diff's own imports.
 */
function buildCatalogExcerpt(req: JudgeRequest): string {
  const imported = extractImportedIdentifiers(req.diffPatch);
  const hidden = req.task.hiddenExpectations?.componentsAnyOf[req.system] ?? [];
  const candidates = new Set<string>([...imported, ...hidden]);
  const names = [...candidates].filter((n) => req.catalog.allExports.includes(n)).sort();

  if (names.length === 0) return '';

  const blocks = names
    .map((n) => findCatalogExport(req.catalog, n))
    .filter((e): e is CatalogExport => !!e)
    .map(renderPropsTable);

  if (blocks.length === 0) return '';

  return [
    '## API reference',
    'The following is factual component API reference for this design system, included for context. It is not a hint about which component is the "correct" or "expected" choice for this task.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

function buildUserPrompt(req: JudgeRequest, rubrics: TaskRubric[]): string {
  const rubricSection = rubrics
    .map((r) => `- id: ${r.id}\n  text: ${r.text}`)
    .join('\n');
  const diffSection = truncateDiff(req.diffPatch);
  const catalogSection = buildCatalogExcerpt(req);

  const parts = [
    '## Original task prompt',
    'This is the intent-level prompt exactly as it was given to the coding agent that produced this change:',
    '"""',
    req.task.prompt,
    '"""',
    '',
    '## Rubric items to grade',
    'Return exactly one verdict for each of the following rubric ids. Do not invent additional ids and do not omit any of these:',
    '',
    rubricSection,
    '',
    '## Artifact under review',
    'This is the unified diff of the code change being judged:',
    '',
    '```diff',
    diffSection,
    '```',
  ];

  if (catalogSection) {
    parts.push('', catalogSection);
  }

  parts.push(
    '',
    '## Instructions',
    'For every rubric id listed above, return a verdict object with:',
    '- "rubricId": the exact id string as given above',
    '- "pass": true only if the diff clearly and unambiguously satisfies that rubric item',
    '- "score": a number from 0 to 1 reflecting how well the change satisfies the item (0 = does not satisfy at all, 1 = fully satisfies)',
    '- "reasoning": a short, specific justification citing what the diff actually does',
    '',
    'Also return "overallNotes": a brief summary of how the change relates to the rubric as a whole.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

interface CliInvocation {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runClaudeCli(args: string[], stdin: string, timeoutMs: number): Promise<CliInvocation> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5000).unref();
    }, timeoutMs);
    killTimer.unref?.();

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      rejectPromise(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolvePromise({ stdout, stderr, exitCode: code, timedOut });
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE etc. if the process died before we finished writing —
      // the 'close'/'error' handlers above already cover that case.
    });
    child.stdin.write(stdin, 'utf8');
    child.stdin.end();
  });
}

/**
 * Parses the `claude --output-format json` envelope out of stdout.
 *
 * Observed quirk: with --json-schema, the CLI sometimes interleaves a stray
 * one-line diagnostic ("Client.listTools() called but server does not
 * advertise tools capability - returning empty list") into stdout alongside
 * the JSON result line. A naive `JSON.parse(stdout)` breaks on that. This
 * parses stdout line-by-line, collects every line that parses as a JSON
 * object, and prefers the one shaped like a `type: "result"` event; falls
 * back to the last parseable object, then to parsing the whole stdout as one
 * document (in case output was pretty-printed across multiple lines).
 */
function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
  const candidates: Record<string, unknown>[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON line on its own — e.g. the stray diagnostic above. Skip it.
    }
  }

  const resultEvent = candidates.find((c) => c.type === 'result');
  if (resultEvent) return resultEvent;
  if (candidates.length > 0) return candidates[candidates.length - 1];

  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to undefined — caller treats this as an unparseable attempt */
  }
  return undefined;
}

/**
 * Validates and normalizes a raw structured-output object (from either the
 * claude CLI's envelope or a provider's parsed JSON) into a JudgeOutput.
 * Shared by both invocation paths so verdict validation stays identical
 * regardless of which one produced the object.
 */
function parseJudgeOutputObject(raw: unknown): JudgeOutput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('judge: no structured output object found');
  }

  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.verdicts)) {
    throw new Error('judge: structured output is missing a "verdicts" array');
  }

  const verdicts: JudgeVerdict[] = obj.verdicts.map((v: unknown, i: number) => {
    if (v === null || typeof v !== 'object') {
      throw new Error(`judge: verdict at index ${i} is not an object`);
    }
    const vv = v as Record<string, unknown>;
    if (typeof vv.rubricId !== 'string') {
      throw new Error(`judge: verdict at index ${i} is missing a string "rubricId"`);
    }
    return {
      rubricId: vv.rubricId,
      pass: Boolean(vv.pass),
      score: typeof vv.score === 'number' && Number.isFinite(vv.score) ? vv.score : 0,
      reasoning: typeof vv.reasoning === 'string' ? vv.reasoning : '',
    };
  });

  const overallNotes = typeof obj.overallNotes === 'string' ? obj.overallNotes : '';
  return { verdicts, overallNotes };
}

/**
 * Pulls the structured JudgeOutput out of a parsed CLI envelope. The CLI puts
 * the validated object on `structured_output` when --json-schema is honored;
 * as a defensive fallback (older/newer CLI behavior) this also tries parsing
 * `result` as JSON if `structured_output` is absent.
 */
function extractJudgeOutput(envelope: Record<string, unknown>): JudgeOutput {
  let raw: unknown = envelope.structured_output;

  if ((raw === null || raw === undefined) && typeof envelope.result === 'string') {
    try {
      raw = JSON.parse(envelope.result);
    } catch {
      throw new Error(
        'judge: envelope had no structured_output and envelope.result was not valid JSON',
      );
    }
  }

  return parseJudgeOutputObject(raw);
}

async function invokeClaudeJudgeOnce(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  timeoutMs: number,
): Promise<JudgeOutput> {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    // Disable every built-in/MCP tool: the judge only ever reads and reasons
    // over the prompt it's given. "" is the CLI's documented way to disable
    // the entire tool set (stronger than enumerating --disallowedTools).
    '--tools',
    '',
    // Don't let the invoking machine's project/user MCP config (e.g. an
    // auth-gated server) affect a headless judge call.
    '--strict-mcp-config',
    // --system-prompt replaces only the system prompt: CLAUDE.md files (the
    // operator's and this repo's, the judge runs from here), auto-memory and
    // hook output still arrive with the messages. The judge needs none of it.
    '--safe-mode',
    '--system-prompt',
    systemPrompt,
    '--json-schema',
    JSON.stringify(JUDGE_OUTPUT_SCHEMA),
  ];

  const { stdout, stderr, exitCode, timedOut } = await runClaudeCli(args, userPrompt, timeoutMs);

  if (timedOut) {
    throw new Error(`judge: claude CLI timed out after ${timeoutMs}ms`);
  }

  const envelope = parseEnvelope(stdout);
  if (!envelope) {
    throw new Error(
      `judge: could not parse any JSON from claude CLI stdout (exit ${exitCode}); stderr: ${stderr.slice(0, 500)}`,
    );
  }

  if (envelope.is_error) {
    const status = envelope.api_error_status ?? 'n/a';
    const msg = typeof envelope.result === 'string' ? envelope.result : stderr.slice(0, 500);
    throw new Error(`judge: claude CLI reported an error (api_error_status=${status}): ${msg}`);
  }

  if (exitCode !== 0) {
    throw new Error(`judge: claude CLI exited with code ${exitCode}; stderr: ${stderr.slice(0, 500)}`);
  }

  return extractJudgeOutput(envelope);
}

/** One retry, covering CLI errors, timeouts, and unparseable/invalid structured output alike. */
async function invokeClaudeJudge(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  timeoutMs: number,
): Promise<JudgeOutput> {
  try {
    return await invokeClaudeJudgeOnce(userPrompt, systemPrompt, model, timeoutMs);
  } catch {
    try {
      return await invokeClaudeJudgeOnce(userPrompt, systemPrompt, model, timeoutMs);
    } catch (secondErr) {
      const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      if (looksLikeUsageLimit(msg)) {
        throw new UsageLimitError(msg);
      }
      throw new Error(`judge: claude CLI invocation failed after 1 retry: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// API-provider judge path (bypasses the claude CLI entirely)
// ---------------------------------------------------------------------------

/** Same prompt text and same JudgeOutput json schema as the CLI path — only the transport differs. */
async function invokeApiJudgeOnce(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  provider: string,
  timeoutMs: number,
): Promise<JudgeOutput> {
  const bench = loadBenchConfig();
  const resolved = resolveProvider(provider, bench);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await chatComplete(resolved, {
      system: systemPrompt,
      user: userPrompt,
      model,
      jsonSchema: { name: 'judge_output', schema: JUDGE_OUTPUT_SCHEMA },
      signal: controller.signal,
    });
    if (result.json === undefined) {
      throw new Error(`judge: provider "${provider}" response had no structured JSON output`);
    }
    return parseJudgeOutputObject(result.json);
  } finally {
    clearTimeout(timer);
  }
}

/** One retry, mirroring invokeClaudeJudge's retry contract for the API path. */
async function invokeApiJudge(
  userPrompt: string,
  systemPrompt: string,
  model: string,
  provider: string,
  timeoutMs: number,
): Promise<JudgeOutput> {
  try {
    return await invokeApiJudgeOnce(userPrompt, systemPrompt, model, provider, timeoutMs);
  } catch (firstErr) {
    if (firstErr instanceof UsageLimitError) throw firstErr;
    try {
      return await invokeApiJudgeOnce(userPrompt, systemPrompt, model, provider, timeoutMs);
    } catch (secondErr) {
      if (secondErr instanceof UsageLimitError) throw secondErr;
      const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(`judge: provider "${provider}" invocation failed after 1 retry: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Enforcement, aggregation, dimension scoring
// ---------------------------------------------------------------------------

/** Guarantees exactly one verdict per task rubric id, in rubric order. */
function normalizeJudgeOutput(raw: JudgeOutput, rubrics: TaskRubric[]): JudgeOutput {
  const byId = new Map(raw.verdicts.map((v) => [v.rubricId, v]));
  const verdicts: JudgeVerdict[] = rubrics.map((r) => {
    const v = byId.get(r.id);
    if (!v) {
      return { rubricId: r.id, pass: false, score: 0, reasoning: 'no verdict returned' };
    }
    return v;
  });
  return { verdicts, overallNotes: raw.overallNotes };
}

function aggregateSamples(
  samples: JudgeOutput[],
  rubrics: TaskRubric[],
): { output: JudgeOutput; varianceNote?: string } {
  const first = samples[0]!;
  let disagreement = false;

  const verdicts: JudgeVerdict[] = rubrics.map((rubric) => {
    const perSample = samples.map(
      (s) => s.verdicts.find((v) => v.rubricId === rubric.id)!,
    );
    const passCount = perSample.filter((v) => v.pass).length;
    // Majority vote; ties (even sample counts split 50/50) count as fail.
    const pass = passCount * 2 > perSample.length;
    const meanScore = perSample.reduce((sum, v) => sum + v.score, 0) / perSample.length;

    if (!perSample.every((v) => v.pass === perSample[0]!.pass)) {
      disagreement = true;
    }

    return {
      rubricId: rubric.id,
      pass,
      score: meanScore,
      reasoning: perSample[0]!.reasoning,
    };
  });

  const output: JudgeOutput = { verdicts, overallNotes: first.overallNotes };
  const varianceNote =
    samples.length > 1 && disagreement
      ? 'Judge samples disagreed on at least one rubric verdict; pass/fail was resolved by majority vote (ties counted as fail) and scores were averaged across samples.'
      : undefined;

  return { output, varianceNote };
}

// ---------------------------------------------------------------------------
// Claim check: what the judge says about imports and components vs the diff
// ---------------------------------------------------------------------------

export interface ContradictedClaim {
  rubricId: string;
  name: string;
  kind: 'import' | 'use';
  reasoning: string;
}

const NEGATION = /\b(?:not|never|no|without|instead of|rather than|fails? to|missing|lacks?)\b|n't\b/i;
const CLAUSE_END = /[.;:!?(]|\s(?:but|rather than|instead of|which|with|from|to|for|that|while|and then)\s|\s[-—]\s/i;
const IDENT = /`<?\/?([A-Za-z_$][\w$-]*)(?:\(\))?\/?>?`|<([A-Z][\w$]*)|\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*)\b/g;

function namesIn(span: string): string[] {
  const out: string[] = [];
  IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(span))) out.push((m[1] ?? m[2] ?? m[3])!);
  return out;
}

function addedLines(diffPatch: string): string[] {
  return diffPatch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
}

/**
 * Claims in verdict rationales that the diff contradicts: a name the judge
 * says is imported that no added import line brings in, or a catalog
 * component it says is used that no added line mentions. Negated claims
 * ("does not use X") are skipped, since absence cannot contradict them, and
 * use-claims are only checked for catalog names, so "uses React state" is
 * not read as a component claim. Deliberately narrow: a missed contradiction
 * costs nothing that today's grading does not already cost, a false one caps
 * a cell for no reason.
 */
export function contradictedClaims(output: JudgeOutput, diffPatch: string, catalog: SystemCatalog): ContradictedClaim[] {
  const added = addedLines(diffPatch);
  const imported = extractImportedIdentifiers(diffPatch);
  const exports = new Set(catalog.allExports);
  // A family name counts when the diff has it as the head of a compound
  // (`DialogRoot`) or a member access (`Dialog.Root`): "uses the Dialog
  // components (DialogRoot, ...)" is a true claim about a diff with no bare
  // `Dialog` in it.
  const wordIn = (name: string, lines: string[]) => {
    const re = new RegExp(`(?<![\\w$-])${name.replace(/[$]/g, '\\$')}(?=[A-Z.]|(?![\\w$-]))`);
    return lines.some((l) => re.test(l));
  };
  const isImported = (name: string) =>
    [...imported].some((i) => i === name || (i.startsWith(name) && /^[A-Z]/.test(i.slice(name.length)))) ||
    wordIn(name, added.filter((l) => /\bimport\b/.test(l)));

  const out: ContradictedClaim[] = [];
  const seen = new Set<string>();
  const flag = (v: JudgeVerdict, name: string, kind: ContradictedClaim['kind']) => {
    const key = `${v.rubricId}|${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rubricId: v.rubricId, name, kind, reasoning: v.reasoning });
  };

  for (const v of output.verdicts) {
    const text = v.reasoning;
    // "<X> (component) is imported": the subject sits before the verb.
    for (const m of text.matchAll(/(`[^`]+`|<?[A-Z][\w$]*>?)\s+(?:components?\s+)?(?:is|are|was|were|gets|got)?\s*imported\b/g)) {
      const before = text.slice(Math.max(0, m.index! - 30), m.index!);
      if (NEGATION.test(before)) continue;
      for (const name of namesIn(m[1]!)) if (!isImported(name)) flag(v, name, 'import');
    }
    // "imports / uses / renders <X, Y and Z>": the objects follow the verb.
    for (const m of text.matchAll(/\b(imports?|importing|imports and uses|uses|using|renders|rendering|builds on|built on|wraps? it in|composes)\s+/gi)) {
      const before = text.slice(Math.max(0, m.index! - 30), m.index!);
      if (NEGATION.test(before)) continue;
      const rest = text.slice(m.index! + m[0].length);
      const end = rest.search(CLAUSE_END);
      const span = end === -1 ? rest : rest.slice(0, end);
      const isImportVerb = /^import/i.test(m[1]!);
      for (const name of namesIn(span)) {
        if (isImportVerb) {
          if (!isImported(name)) flag(v, name, 'import');
        } else if (exports.has(name) && !wordIn(name, added)) {
          flag(v, name, 'use');
        }
      }
    }
  }
  return out;
}

function computeDimension(
  rubrics: TaskRubric[],
  aggregatedVerdicts: JudgeVerdict[],
  withheld: Map<string, string>,
  contradicted: ContradictedClaim[] = [],
): DimensionResult | undefined {
  const byId = new Map(aggregatedVerdicts.map((v) => [v.rubricId, v]));
  let rawScore = 0;
  let weightSum = 0;
  let gate: Gate = 'pass';
  const diffs: Diff[] = [];

  for (const rubric of rubrics) {
    if (withheld.has(rubric.id)) continue;
    const v = byId.get(rubric.id);
    const score = v?.score ?? 0;
    rawScore += rubric.weight * score;
    weightSum += rubric.weight;

    const passed = v?.pass ?? false;
    if (!passed) {
      diffs.push({
        dimension: 'judgment',
        message: `${rubric.id}: ${v?.reasoning ?? 'no verdict returned'}`,
      });
      if (rubric.critical) {
        gate = 'review'; // the judge never issues 'fail' on its own
      }
    }
  }

  // A withheld rubric's weight goes to the rest proportionally, and it can
  // never gate: the system was not asked a question it can answer.
  for (const [rubricId, why] of withheld) {
    diffs.push({
      dimension: 'judgment',
      message: `${rubricId} withheld: it ${why}`,
      fix: 'if the system provides this under another name, list it in systems.config.json "affordances"',
    });
  }

  // A rationale the diff contradicts means this verdict cannot be trusted as
  // it stands: the cell is capped at review and the claim is shown with the
  // rationale it came from. The score is left alone; a human decides.
  for (const c of contradicted) {
    gate = 'review';
    diffs.push({
      dimension: 'judgment',
      message: `judge claim contradicted by the diff: "${c.rubricId}" says ${c.name} is ${c.kind === 'import' ? 'imported' : 'used'}, and no added line ${c.kind === 'import' ? 'imports' : 'mentions'} ${c.name}`,
      fix: `check this verdict by hand. Rationale: "${c.reasoning}"`,
    });
  }

  if (weightSum === 0) return undefined;
  return {
    dimension: 'judgment',
    score: Math.round((rawScore / weightSum) * 100 * 100) / 100, // 0–100, 2dp
    gate,
    diffs,
  };
}

/**
 * The judgment dimension for an aggregated judge output: withholds rubrics the
 * system cannot be graded on and scores the rest. Pure, so `grade` can replay
 * stored verdicts (judge.json) through current rules without calling a model.
 */
export function scoreJudgeOutput(opts: {
  task: Task;
  catalog: SystemCatalog;
  systemCfg?: SystemConfig;
  output: JudgeOutput;
  diffPatch: string;
}): DimensionResult | undefined {
  const withheld = withheldRubrics(opts.task, opts.catalog, opts.systemCfg);
  const contradicted = contradictedClaims(opts.output, opts.diffPatch, opts.catalog);
  return computeDimension(opts.task.rubrics, opts.output.verdicts, withheld, contradicted);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function judgeArtifact(req: JudgeRequest): Promise<JudgeResult> {
  const withheld = withheldRubrics(req.task, req.catalog, req.systemCfg);
  const rubrics = req.task.rubrics.filter((r) => !withheld.has(r.id));
  const empty: JudgeOutput = { verdicts: [], overallNotes: '' };
  if (rubrics.length === 0) {
    return { output: empty, rawSamples: [], dimension: scoreJudgeOutput({ ...req, output: empty }) };
  }

  const systemPrompt = buildJudgeSystemPrompt(req.system);
  const userPrompt = buildUserPrompt(req, rubrics);
  const samples = Math.max(1, Math.floor(req.samples));

  const useApiProvider = !!req.provider && req.provider !== 'claude-cli';

  const rawSamples: JudgeOutput[] = [];
  for (let i = 0; i < samples; i++) {
    const raw = useApiProvider
      ? await invokeApiJudge(userPrompt, systemPrompt, req.model, req.provider!, req.timeoutMs)
      : await invokeClaudeJudge(userPrompt, systemPrompt, req.model, req.timeoutMs);
    rawSamples.push(normalizeJudgeOutput(raw, rubrics));
  }

  const { output, varianceNote } = aggregateSamples(rawSamples, rubrics);
  const dimension = scoreJudgeOutput({ task: req.task, catalog: req.catalog, systemCfg: req.systemCfg, output, diffPatch: req.diffPatch });

  return { output, rawSamples, dimension, varianceNote };
}
