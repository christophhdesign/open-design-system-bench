// Shared contracts for open-design-system-bench. The Gate/DimensionResult/EvalResult shapes
// are ported from eval-harness/src/types.ts — the workspace's canonical output
// contract — so downstream surfaces (CI, dashboards) can consume either tool.

// ---------------------------------------------------------------------------
// Scoring contract (ported from eval-harness)
// ---------------------------------------------------------------------------

export type Gate = 'pass' | 'review' | 'fail';

export interface Diff {
  dimension: string;
  message: string;
  fix?: string; // actionable, e.g. "use Button variant=\"destructive\", not bg-[#e11d48]"
}

export interface DimensionResult {
  dimension: string;
  score: number; // 0–100
  gate: Gate;
  diffs: Diff[];
}

export interface EvalResult {
  overall: number; // 0–100
  gate: Gate; // worst-case across dimensions
  dimensions: Record<string, DimensionResult>;
  diffs: Diff[]; // flattened, actionable
}

// ---------------------------------------------------------------------------
// Systems & ground truth
// ---------------------------------------------------------------------------

/** A design system's id — the key it's registered under in systems.config.json. Any string; the harness places no restriction on how many systems, or what they're called. */
export type SystemId = string;

export interface SystemConfig {
  root: string; // resolved absolute path (env override applied)
  rootEnv: string;
  componentsSrc: string; // relative to root
  componentsPkg: string; // e.g. "@your-scope/components"
  foundationsPkg: string;
  /**
   * Path(s) (relative to root) to the foundations CSS the token set is parsed
   * from. Accepts an array because plenty of systems split their tokens across
   * one file per category (Admiral ships nineteen: palette.css, spacing.css,
   * radius.css, ...) with no aggregate CSS entry point — only a .scss that
   * `@use`s them, which is not something a dumb line scan should be asked to
   * resolve. Listed files are read in order and treated as one concatenated
   * document, so cssVars/utilities are the union and cssHash covers the lot.
   * Omit entirely if the system has no CSS-custom-property token file — the
   * token/contamination checks that depend on it are skipped, and `doctor` warns.
   */
  foundationsCss?: string | string[];
  catalogStrategy: 'docgen' | 'catalog-json' | 'stencil';
  /**
   * Path (relative to root) to a pre-built machine-readable component catalog
   * JSON file. Required by both the 'catalog-json' strategy (which expects
   * this repo's own catalog shape) and the 'stencil' strategy (which expects
   * the docs.json emitted by Stencil's `docs-json` output target).
   */
  catalogFile?: string;
  agentContext: {
    agentsMd: string[]; // files copied at context level "agents-md" (relative to root)
    skillDirs?: string[]; // skill bundles copied into .claude/skills/ at context level "skill"
    extraDocs?: string[]; // extra files/dirs copied into workspace docs/ at context level "skill"
  };
  /** Cross-system contamination sentinels (only meaningful when benchmarking more than one system side by side). Omit for a single-system setup — the apiFidelity grader simply skips these checks. */
  contamination?: {
    props: string[]; // prop names that belong to another configured system
    typographyStyle: 'camel' | 'kebab'; // this system's typography utility casing
  };
  /** Path to this system's fixture template app (relative to the package root). Defaults to fixtures/<systemId>-app. */
  fixtureTemplate?: string;
  /**
   * How the fixture template consumes this system's components. 'source' (the
   * default, omit to get current behavior) aliases the fixture straight at
   * the system's source dir via vite/tsconfig path aliases — no build step,
   * best when you have the DS repo checked out (monorepos). 'npm' installs
   * the published package into a per-system prepared workspace
   * (fixtures/.prepared/<systemId>-app) instead, for systems only available
   * as a published npm package with no local source checkout.
   */
  consume?: 'source' | 'npm';
  /**
   * Accessible-name vocabulary for the a11yStatic grader, merged over
   * conventional defaults (Input, Select, Toggle, Checkbox, IconButton,
   * FormField, ...). Declare only the names that differ in your system: a text
   * field called `TextEntry` is otherwise invisible to the grader.
   */
  a11y?: {
    /** Form controls that need an accessible name (your Input/Select/Toggle equivalents). */
    controls?: string[];
    /** Icon-only controls whose name must come from aria-label or child text. */
    iconOnly?: string[];
    /** Components that render a <label> for a control. */
    labels?: string[];
    /** Wrappers that associate a label with a control via context, no htmlFor needed. */
    formContext?: string[];
    /**
     * Controls whose documented accessible name comes from `placeholder`. No
     * default, since placeholder-as-name is normally an anti-pattern.
     */
    placeholderNamed?: string[];
  };
  /**
   * npm install spec for 'npm' consume mode, e.g. "@acme/ui" or
   * "@acme/ui@^2.0.0". Defaults to componentsPkg when omitted. Ignored in
   * 'source' mode.
   */
  packageSpec?: string;
  /**
   * Extra npm install specs resolved together with packageSpec in 'npm'
   * consume mode, for pinning peer dependencies the generic fixture template
   * would otherwise satisfy with a conflicting major (a library still on React 18
   * needs ["react@^18.3.1", "react-dom@^18.3.1", "@types/react@^18",
   * "@types/react-dom@^18"] against the template's React 19). Ignored in
   * 'source' mode.
   */
  fixturePins?: string[];
  /**
   * Import specifier for the system's stylesheet, imported by the fixture's
   * src/main.tsx in 'npm' consume mode, e.g. "@acme/ui/styles.css". Optional
   * — omit for systems with no importable CSS entry (CSS-in-JS,
   * Tailwind-only via className, etc.). Ignored in 'source' mode.
   */
  cssEntry?: string;
  /**
   * Base URL of the system's hosted docs site (e.g. "https://mantine.dev").
   * Enables the audit's opt-in hosted-surface probes (llms.txt,
   * llms-full.txt, /mcp/index.json, /registry.json served from the live
   * site rather than committed to the repo). Omit for a fully offline
   * audit: without this set, `audit` never touches the network.
   */
  docsUrl?: string;
}

export type SystemsConfig = Record<SystemId, SystemConfig>;

export interface CatalogProp {
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
  description?: string;
}

export interface CatalogExport {
  displayName: string; // PascalCase public symbol
  description: string;
  props: CatalogProp[];
  /**
   * Names (only) of props whose declaration lives outside the system's
   * componentsSrc tree: styled-system spreads, polymorphic factory types,
   * DOM/HTML attribute intersections, and similar inherited surfaces.
   * Deliberately name-only — capturing full CatalogProp metadata (type,
   * description, default) for the hundreds of inherited props a single
   * component can carry is what ballooned real-world catalogs past 100 MB
   * (measured: ~845 style-system props per component on Chakra UI). These
   * names still count toward `allPropsByExport`, so grading (the
   * invented-prop check in apiFidelity, which keys off allPropsByExport) is
   * unaffected — only the catalog-quality check's per-prop coverage
   * reporting is scoped to own props. Omitted (not an empty array) when an
   * export has no inherited props.
   */
  inheritedProps?: string[];
}

export interface SystemCatalog {
  system: SystemId;
  generatedAt: string;
  source: { root: string; commit: string; srcHash: string };
  components: Array<{ dir: string; exports: CatalogExport[] }>;
  allExports: string[]; // flat symbol list — the hallucination check set
  allPropsByExport: Record<string, string[]>;
}

export interface SystemTokens {
  system: SystemId;
  generatedAt: string;
  cssVars: string[]; // e.g. "--text-primary"
  utilities: string[]; // all @utility names
  typographyUtilities: string[]; // subset, used by contamination check
  cssHash: string;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface TaskRubric {
  id: string;
  text: string;
  weight: number; // rubric weights per task sum to 1
  critical?: boolean; // failed critical rubric → gate 'review'
}

export interface Task {
  id: string;
  title: string;
  /** Which configured systems this task applies to. Absent, or ['*'], means every configured system. */
  systems?: SystemId[];
  prompt: string; // intent-level; must NOT name catalog components
  /**
   * Never shown to the generating agent; per-system acceptable component
   * choices. Optional — a task authored against a stranger's system can't
   * know its component names in advance. When absent, validate-tasks warns
   * (not errors) and the judge omits the expected-components catalog excerpt.
   */
  hiddenExpectations?: {
    componentsAnyOf: Partial<Record<SystemId, string[]>>;
    notes?: string;
  };
  rubrics: TaskRubric[];
  mechanicalOverrides?: {
    allowHexIn?: string[]; // file globs where hex literals are tolerated
    extraAllowedImports?: string[];
  };
  timeoutSec?: number;
}

// ---------------------------------------------------------------------------
// Bench config & matrix
// ---------------------------------------------------------------------------

export type ContextLevel = 'bare' | 'agents-md' | 'skill' | 'mcp'; // 'mcp' reserved: next phase

export interface BenchProfile {
  systems: SystemId[];
  contexts: ContextLevel[];
  models: string[];
  tasks: string[] | '*';
  reps: number;
}

// ---------------------------------------------------------------------------
// Providers (bring-your-own-key / gateway support)
// ---------------------------------------------------------------------------

/**
 * 'openai'    — OpenAI-compatible chat completions wire format (POST
 *               {baseUrl}/chat/completions), used for OpenAI itself and any
 *               OpenAI-compatible gateway.
 * 'anthropic' — Anthropic Messages API wire format (POST {baseUrl}/v1/messages),
 *               used for Anthropic itself and byte-for-byte-compatible
 *               gateways (an Anthropic-shaped /v1/messages passthrough).
 */
export type ProviderKind = 'openai' | 'anthropic';

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  /** Name of the env var holding the API key (never the key itself). */
  apiKeyEnv: string;
}

export interface BenchConfig {
  profiles: Record<string, BenchProfile>;
  /** Named provider configs for qualified model strings ("openai:gpt-5.2") and --judge-provider. */
  providers?: Record<string, ProviderConfig>;
  defaults: {
    agent: string;
    generatorModel: string;
    judgeModel: string;
    /** Default judge provider id (key into `providers`); unset/'claude-cli' = the claude CLI judge. */
    judgeProvider?: string;
    taskTimeoutSec: number;
    judgeTimeoutSec: number;
    concurrency: number;
    judgeSamples: number;
    /** Extra attempts when a generation times out (default 1 = one retry). */
    retryTimeouts?: number;
    /** Directory the task suite is loaded from (relative to the package root unless absolute). Default './tasks'. Overridable per-invocation via --tasks-dir. */
    tasksDir?: string;
  };
  ci: {
    maxScoreDrop: number;
    maxErroredCellRatio: number;
  };
}

export interface CellSpec {
  system: SystemId;
  context: ContextLevel;
  model: string;
  agent: string;
  taskId: string;
  rep: number; // 1-based
}

export type CellStatus = 'ok' | 'agent-error' | 'timeout' | 'skipped';

/** Stable directory-name id for a cell, e.g. "my-system_agents-md_sonnet". */
export function cellKey(c: Pick<CellSpec, 'system' | 'context' | 'model'>): string {
  return `${c.system}_${c.context}_${c.model}`;
}

// ---------------------------------------------------------------------------
// Agent adapter
// ---------------------------------------------------------------------------

export interface AgentGenerateRequest {
  workspaceDir: string;
  prompt: string;
  model: string;
  /** Provider id (key into BenchConfig.providers) for adapters that talk to a provider directly, e.g. 'api-oneshot'. */
  provider?: string;
  appendSystemPrompt?: string;
  addDirs: string[];
  mcpConfigPath?: string; // reserved for next phase
  extraAllowedTools?: string[];
  timeoutMs: number;
  transcriptPath: string; // where the adapter tees the stream
}

/** Token counts from an API-provider completion (OpenAI- or Anthropic-shaped). */
export interface TokenUsage {
  /** Prompt-side tokens, including any cache-read / cache-creation tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface AgentGenerateResult {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  durationMs: number;
  costUsd?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
  transcriptPath: string;
  resultText?: string;
  /** Present when !ok: classifies whether the failure looks like a usage/rate limit. */
  errorKind?: 'usage-limit' | 'other';
}

export interface AgentAdapter {
  id: string; // 'claude-code' | 'codex' | …
  detect(): Promise<{ ok: boolean; version?: string; error?: string }>;
  generate(req: AgentGenerateRequest): Promise<AgentGenerateResult>;
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export interface JudgeVerdict {
  rubricId: string;
  pass: boolean;
  score: number; // 0–1
  reasoning: string;
}

export interface JudgeOutput {
  verdicts: JudgeVerdict[];
  overallNotes: string;
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

export interface AgentMeta {
  durationMs: number;
  costUsd?: number;
  numTurns?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CellRecord {
  cell: { system: SystemId; context: ContextLevel; model: string; agent: string };
  taskId: string;
  rep: number;
  status: CellStatus;
  skipReason?: string;
  agentMeta?: AgentMeta;
  /** Relative paths within the run dir (diff.patch, transcript.jsonl, judge.json). */
  artifacts?: { dir: string; diffPatch?: string; transcript?: string; judgeJson?: string };
  result?: EvalResult; // absent when status !== 'ok'
}

export interface RunManifest {
  runId: string;
  label?: string;
  profile: string;
  startedAt: string;
  finishedAt?: string;
  nodeVersion: string;
  adapters: Record<string, { version?: string }>;
  systems: Partial<
    Record<SystemId, { root: string; commit: string; catalogSrcHash: string; tokensCssHash: string }>
  >;
  cells: Array<{ spec: CellSpec; status: CellStatus; skipReason?: string }>;
  totalCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  wallClockMs?: number;
  /** True when the run stopped early on a usage limit, leaving pending cells un-run. */
  paused?: boolean;
  pausedReason?: string;
}

export interface RunResults {
  runId: string;
  manifest: RunManifest;
  records: CellRecord[];
  /** Per (cellKey, taskId): mean/std of overall across reps with status ok. */
  aggregates: Array<{
    cellKey: string;
    system: SystemId;
    context: ContextLevel;
    model: string;
    taskId: string;
    n: number;
    meanOverall: number;
    stdOverall: number;
    worstGate: Gate;
    meanDimensions: Record<string, number>;
  }>;
}
