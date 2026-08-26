// LLM-as-judge grader. Runs the locally installed `claude` CLI headless,
// in structured-output mode, to grade a code-change artifact against a
// task's rubric. This module never talks to the Claude API directly — it
// shells out to `claude -p` so the judge model, auth, and rate limits are
// whatever the operator's `claude` install already has configured.

import { spawn } from 'node:child_process';
import { looksLikeUsageLimit, UsageLimitError } from '../agents/errors.ts';
import { loadBenchConfig } from '../config.ts';
import { chatComplete, resolveProvider } from '../providers/client.ts';
import type {
  CatalogExport,
  Diff,
  DimensionResult,
  Gate,
  JudgeOutput,
  JudgeVerdict,
  SystemCatalog,
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
}

export interface JudgeResult {
  output: JudgeOutput; // aggregated
  rawSamples: JudgeOutput[];
  dimension: DimensionResult; // dimension:'judgment'
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
 * diff. Used only to decide which catalog components are "in play" for this
 * change — results are filtered against catalog.allExports by the caller, so
 * false positives (e.g. `import clsx from 'clsx'`) are harmless.
 */
function extractImportedIdentifiers(diffPatch: string): Set<string> {
  const ids = new Set<string>();
  const namedImportRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]+['"]/g;
  const defaultImportRe = /import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"][^'"]+['"]/g;

  for (const rawLine of diffPatch.split('\n')) {
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;
    const line = rawLine.slice(1);

    namedImportRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = namedImportRe.exec(line))) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/i)[0]?.trim();
        if (name) ids.add(name);
      }
    }

    defaultImportRe.lastIndex = 0;
    while ((m = defaultImportRe.exec(line))) {
      if (m[1]) ids.add(m[1]);
    }
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

function buildUserPrompt(req: JudgeRequest): string {
  const rubricSection = req.task.rubrics
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

function computeDimension(rubrics: TaskRubric[], aggregatedVerdicts: JudgeVerdict[]): DimensionResult {
  const byId = new Map(aggregatedVerdicts.map((v) => [v.rubricId, v]));
  let rawScore = 0;
  let gate: Gate = 'pass';
  const diffs: Diff[] = [];

  for (const rubric of rubrics) {
    const v = byId.get(rubric.id);
    const score = v?.score ?? 0;
    rawScore += rubric.weight * score;

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

  return {
    dimension: 'judgment',
    score: Math.round(rawScore * 100 * 100) / 100, // 0–100, 2dp
    gate,
    diffs,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function judgeArtifact(req: JudgeRequest): Promise<JudgeResult> {
  const systemPrompt = buildJudgeSystemPrompt(req.system);
  const userPrompt = buildUserPrompt(req);
  const samples = Math.max(1, Math.floor(req.samples));

  const useApiProvider = !!req.provider && req.provider !== 'claude-cli';

  const rawSamples: JudgeOutput[] = [];
  for (let i = 0; i < samples; i++) {
    const raw = useApiProvider
      ? await invokeApiJudge(userPrompt, systemPrompt, req.model, req.provider!, req.timeoutMs)
      : await invokeClaudeJudge(userPrompt, systemPrompt, req.model, req.timeoutMs);
    rawSamples.push(normalizeJudgeOutput(raw, req.task.rubrics));
  }

  const { output, varianceNote } = aggregateSamples(rawSamples, req.task.rubrics);
  const dimension = computeDimension(req.task.rubrics, output.verdicts);

  return { output, rawSamples, dimension, varianceNote };
}
