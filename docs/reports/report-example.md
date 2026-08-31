---
schemaVersion: 1
reportId: my-system-2026-01-01-medium
generatedAt: '2026-01-01'
title: My system - AI-readiness benchmark report
author:
  kind: agent
  model: claude-opus-5
  tool: claude-code
subject:
  systemId: my-system
  displayName: My system
  commit: abc1234
  packages:
    - name: '@example/components'
      version: 2.4.0
      role: components
    - name: '@example/tokens'
      version: 1.1.0
      role: foundations
harness:
  version: 0.1.0
  repo: https://github.com/open-design-system-bench
provenance:
  runs:
    - runId: 20260101-000000-example
      label: example
      profile: medium
      role: primary
      cellCount: 4
      startedAt: '2026-01-01T00:00:00.000Z'
      finishedAt: '2026-01-01T00:24:00.000Z'
  catalog:
    components: 20
    exports: 24
    props: 96
    cssVars: 120
    utilities: 0
methodology:
  consume: source
  contexts:
    - agents-md
    - skill
  models:
    - sonnet
  agents:
    - claude-code
  reps: 1
  comparabilityKey: >-
    profile=medium;contexts=agents-md,skill;reps=1;consume=source;fixture=fixtures/my-system-app;tasks=2
  judge:
    model: haiku
    samples: 1
  fixtureTemplate: fixtures/my-app
  deviations:
    - change: Tailwind removed from the fixture template.
      rationale: >-
        Consumers of this system do not use Tailwind. Leaving it in would offer the agent a styling
        escape hatch that does not exist in production, which distorts tokenDiscipline.
results:
  cellCount: 4
  okCount: 4
  erroredCount: 0
  meanOverall: 85.875
  medianOverall: 90.25
  minOverall: 63
  maxOverall: 100
  gateCounts:
    pass: 2
    review: 1
    fail: 1
  perfectCells: 1
  costUsd: 3.6
  wallClockMs: 1440000
  inputTokens: null
  outputTokens: null
  dimensionMeans:
    imports: 100
    apiFidelity: 75
    tokenDiscipline: 100
    a11yStatic: 100
    compile: 100
    judgment: 73.75
  byContext:
    - context: agents-md
      cellCount: 2
      meanOverall: 91
      dimensionMeans:
        imports: 100
        apiFidelity: 100
        tokenDiscipline: 100
        a11yStatic: 100
        compile: 100
        judgment: 70
      gateCounts:
        pass: 1
        review: 1
        fail: 0
    - context: skill
      cellCount: 2
      meanOverall: 80.75
      dimensionMeans:
        imports: 100
        apiFidelity: 50
        tokenDiscipline: 100
        a11yStatic: 100
        compile: 100
        judgment: 77.5
      gateCounts:
        pass: 1
        review: 0
        fail: 1
audit:
  basis: partial-behavioral
  composite: 82
  tier: AI-native
  axes:
    surface:
      score: 72.7
    lift:
      score: null
    ceiling:
      score: 80.4
    engagement:
      score: 75
    vocabularyBehavioral:
      score: 100
  surfaceChecks:
    surface: 35
    catalog-quality: 90
    export-hygiene: 100
    vocabulary: 93
    tokens: 40
    deprecation: 75
    docs-greppability: 72
citedFigures:
  - id: token-source-references
    value: 118
    source: packages/tokens/src/semantic-colors.json
    method: >-
      count of values referencing another token by name in the token source, before the build step
      flattens them
findings:
  - id: no-agents-md
    title: No AGENTS.md at the system root
    severity: gap
    status: confirmed
    owner: system
    section: '5.1'
    evidence:
      - kind: auditCheck
        checkId: surface
    recommendationIds:
      - add-agents-md
  - id: flat-token-output
    title: Token references are flattened at build time
    severity: gap
    status: confirmed
    owner: system
    section: '5.2'
    evidence:
      - kind: auditCheck
        checkId: tokens
      - kind: figure
        figureId: token-source-references
    recommendationIds:
      - emit-token-references
  - id: input-not-textfield
    title: Input diverges from the TextField convention
    severity: divergence
    status: confirmed
    owner: system
    section: '5.3'
    evidence:
      - kind: auditCheck
        checkId: vocabulary
  - id: skill-bypasses-pagination
    title: The skill steered the agent away from the shipped Pagination
    severity: defect
    status: confirmed
    owner: system
    section: '5.4'
    evidence:
      - kind: cell
        runId: 20260101-000000-example
        cellKey: my-system_skill_sonnet
        taskId: data-table-pagination
        rep: 1
        dimension: apiFidelity
    recommendationIds:
      - name-pagination-in-skill
  - id: destructive-action-hierarchy
    title: Destructive actions carry the same emphasis as safe ones
    severity: defect
    status: open
    owner: system
    section: '5.5'
    evidence:
      - kind: cell
        runId: 20260101-000000-example
        cellKey: my-system_agents-md_sonnet
        taskId: destructive-confirmation
        rep: 1
        dimension: judgment
    recommendationIds:
      - encode-action-hierarchy
recommendations:
  - id: add-agents-md
    title: Add an AGENTS.md at the system root
    effort: low
    breaking: false
    findingIds:
      - no-agents-md
  - id: emit-token-references
    title: Enable outputReferences in the token build
    effort: low
    breaking: false
    findingIds:
      - flat-token-output
  - id: name-pagination-in-skill
    title: Name Pagination explicitly in the skill bundle
    effort: low
    breaking: false
    findingIds:
      - skill-bypasses-pagination
  - id: encode-action-hierarchy
    title: Encode destructive-action hierarchy as a composition rule
    effort: medium
    breaking: false
    findingIds:
      - destructive-action-hierarchy
validityLimits:
  - id: single-rep
    text: >-
      Every cell is a single sample. Nothing here distinguishes a systematic effect from model
      variance. Three repetitions are the minimum for that.
  - id: no-bare-context
    text: >-
      The run has no bare context, so Lift is unmeasurable and the composite falls back to
      partial-behavioral. It should not be compared against a composite computed on a different
      basis.
  - id: authors-rubrics
    text: >-
      The judgment rubrics ship with the benchmark and encode its author's view of good design, not
      this system's. Rewriting them would turn this axis into a conformance test.
---

# My system - AI-readiness benchmark report

## 1. Executive summary

| Metric | Value |
|---|---|
| Mean score across 4 graded cells | **85.88 / 100** |
| Median | 90.25 |
| Range | 63.00 - 100.00 |
| Gate outcomes | 2 pass / 1 review / 1 fail |
| Perfect cells | 1 |
| AI-Readiness composite | 82.0 (AI-native, partial-behavioral) |
| Cost | $3.60 |
| Wall clock | 24m 0s |

## 2. Methodology

The benchmark was pointed at this system as it stands. No files were added to the system
repository to improve its score, and the repository was read from only.

### 2.1 What the benchmark does

The harness issues intent-level task prompts to a headless coding agent inside a disposable
fixture workspace that consumes the design system under test. Task prompts never name a
component: they describe a user-facing outcome. The generated diff is then graded across six
dimensions, five mechanical (deterministic, AST- and compiler-based) and one model-judged.

Each task runs at one or more context levels, which control how much guidance the agent receives:

| Context | Injected into the workspace |
|---|---|
| `bare` | Nothing. The agent has only the fixture and whatever the fixture exposes. |
| `agents-md` | The files listed in `agentContext.agentsMd`, copied in as both `AGENTS.md` and `CLAUDE.md`. |
| `skill` | Everything from `agents-md`, plus skill bundles into `.claude/skills/` and reference docs into `docs/`. |

The comparison between context levels is the point of the exercise. It measures how much a given
documentation layer actually changes agent behaviour, rather than whether the documentation exists.

### 2.2 Configuration used

```json
{
  "root": "<system checkout>",
  "componentsSrc": "packages/components/src",
  "componentsPkg": "@example/components",
  "foundationsPkg": "@example/tokens",
  "foundationsCss": "packages/tokens/dist/variables.css",
  "catalogStrategy": "docgen",
  "consume": "source",
  "agentContext": {
    "agentsMd": [
      "README.md"
    ],
    "skillDirs": [
      ".claude/skills/compose-ui"
    ]
  }
}
```

### 2.3 Extraction results

```
components   20
exports      24
props        96
cssVars     120
utilities     0
```

### 2.4 Fixture deviations

The stock fixture template was modified in one respect:

| Change | Rationale |
|---|---|
| Tailwind removed | Consumers of this system do not use Tailwind. Retaining it would offer the agent a styling escape hatch that does not exist in production, distorting `tokenDiscipline`. |

Comparability caveat: this deviation means scores are not strictly comparable against other
systems benchmarked on the unmodified template. The `comparabilityKey` in the front matter
records it.

## 3. What each axis measures

Six dimensions compose the per-cell score. `overall` is the weighted mean, renormalised over the
dimensions actually present. The gate is the **worst case** across dimensions: a single `fail`
fails the cell regardless of how high the weighted mean is. Weights come from `rubric.config.ts`.

| Dimension | Weight | What it checks |
|---|---|---|
| `imports` | 10% | Every import source in the diff, against an allowlist: the system's own packages and subpaths, React, the build tool, relative paths, and per-task extras. Detects the agent reaching for an outside UI library instead of the system under test. |
| `apiFidelity` | 25% | That every symbol imported from the system exists in the extracted catalog (hallucinated component), and that every prop passed to a catalogued component is a real prop (invented prop). A diff that imports nothing from the system scores 0: that is the "ignored the library entirely" case. |
| `tokenDiscipline` | 15% | Raw hex colours, `rgb()`/`rgba()` calls, and raw `px`/`rem` dimensions in `className` strings and inline style objects. It does not attempt to validate every utility class against the token list. |
| `a11yStatic` | 10% | A dependency-free reimplementation of eight `eslint-plugin-jsx-a11y` rules over a Babel AST pass. `control-has-name` is the discriminating check: an unlabelled control is a common real failure, which is why the `a11y` vocabulary in the system config matters. |
| `compile` | 10% | `tsc --noEmit` against the generated workspace, type-checking the agent's code against the design system's real types. This catches genuine API drift whether or not the catalog knows about it. |
| `judgment` | 30% | A separate model evaluates the diff against per-task rubrics authored in the task YAML, each with a weight and an optional `critical` flag. This measures whether the agent made the right design decisions, independent of whether the code compiles. |

Gate policy, as enforced by the graders:

| Finding | Gate |
|---|---|
| Hallucinated component | `fail` (the headline metric) |
| Compile error | `fail` |
| Two or more foreign UI-library imports | `fail` (exactly one is `review`) |
| Invented prop | `review` (docgen gaps get human triage) |
| Spread props, unverifiable | capped at `review` |
| More than three token violations | `review` |
| Any static a11y error | `review` |
| Failed critical judge rubric | `review` (the judge alone never fails a run) |

Separately, the AI-Readiness Score composes five axes. `Surface` is static and always computable;
the other four need a run. `Lift` needs a `bare` context specifically, and is `n/a` without one.
The `basis` field records which axes could be computed, and composites with different bases are
not comparable to each other.

## 4. Results

Per-cell scores and the context comparison follow. Every figure below is generated.

### 4.1 All cells

Weights: imports 10% / apiFidelity 25% / tokenDiscipline 15% / a11yStatic 10% / compile 10% / judgment 30%

| # | Task | Context | `imports` | `apiFidelity` | `tokenDiscipline` | `a11yStatic` | `compile` | `judgment` | Overall | Gate |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | data-table-pagination | agents-md | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.00 | pass |
| 2 | data-table-pagination | skill | 100.0 | 0.0 | 100.0 | 100.0 | 100.0 | 60.0 | 63.00 | **fail** |
| 3 | destructive-confirmation | agents-md | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 40.0 | 82.00 | review |
| 4 | destructive-confirmation | skill | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 95.0 | 98.50 | pass |

### 4.2 By context

|  | `agents-md` | `skill` | Delta |
|---|---|---|---|
| `imports` | 100.0 | 100.0 | +0.0 |
| `apiFidelity` | 100.0 | 50.0 | -50.0 |
| `tokenDiscipline` | 100.0 | 100.0 | +0.0 |
| `a11yStatic` | 100.0 | 100.0 | +0.0 |
| `compile` | 100.0 | 100.0 | +0.0 |
| `judgment` | 70.0 | 77.5 | +7.5 |
| **Mean overall** | **91.00** | **80.75** | **-10.25** |
| Gates | 1 pass / 1 review / 0 fail | 1 pass / 0 review / 1 fail |  |
| Cells | 2 | 2 |  |

## 5. Findings

Five findings. Each cites evidence that resolves against the run or the static audit.

### 5.1 No AGENTS.md at the system root

The enablement surface check scored 35.0, the lowest of the seven static checks, and reports
no `AGENTS.md` or `CLAUDE.md` at the system root.

This matters more than its weight suggests. Every guided context level begins by copying the
files named in `agentContext.agentsMd`, so the absence of a purpose-written one means the
benchmark measures whatever general-purpose README happens to be there instead. It is the
single highest-leverage missing asset.

### 5.2 Token references are flattened at build time

Token machine-readability scored 40.0, reporting that no shipped custom property references
another. The measurement is accurate for the shipped artefact, but the inference that this is
a flat token list is wrong: the token source does carry a semantic layer, with 118 references
that the build step resolves rather than emitting as `var()` chains.

The semantic layer exists in source and is destroyed in output, so anything consuming the
shipped CSS, agents included, sees only flat literals. This is an output-format change, not a
token redesign.

### 5.3 Input diverges from the TextField convention

The vocabulary check reports that models invented the name `TextField` 21 times across its
mined sample, where this system ships `Input`.

This is a divergence, not a defect. Every design system chooses names, and the number only
quantifies how often a model will guess wrong before reading the source. It is worth knowing
when writing the `AGENTS.md` that 5.1 calls for: naming the alias explicitly costs one line.

### 5.4 The skill steered the agent away from the shipped Pagination

The `data-table-pagination` task under the `skill` context scored 0.0 on `apiFidelity` with
the grader reporting no design-system components used, and gated `fail`. The agent wrote its
own pagination component rather than importing the one the system ships.

The generated code compiles and is accessible. It scored 100.0 on token discipline, faithfully
using the system's custom properties while reimplementing a component the library already has.
That combination is the signature of this failure mode: the output looks correct in isolation
and is wrong in the only way that matters.

The same task under `agents-md` used the shipped components and scored 100.00. The guidance
layer made the result worse, which is exactly the comparison the context levels exist to make.

### 5.5 Destructive actions carry the same emphasis as safe ones

The `destructive-confirmation` task under `agents-md` scored 100.0 on all five mechanical
dimensions and 40.0 on judgment. The judge found all three actions rendered with identical
emphasis, so the destructive option carried the same visual weight as the safe one.

The code was clean, compiling, token-correct and accessible. It also presented "cancel your
subscription" with the same prominence as "keep my plan". This is the failure class the
mechanical dimensions are structurally incapable of catching, and it is why judgment carries
the heaviest weight.

## 6. Notable individual results

The `destructive-confirmation` cell described in 5.5 is worth restating as a pattern rather
than an incident: mechanically perfect, and wrong.

| Dimension | Score |
|---|---|
| Five mechanical dimensions | 100.0 each |
| `judgment` | 40.0 |
| Overall | 82.00 |

A reader scanning only the mechanical columns would record this cell as a success. The gate
caught it because a critical rubric failed, which is the worst-case gate doing its job.

## 7. Harness defects

None. The harness ran without error, and no cell was lost to a benchmark defect.

This section exists because a benchmark that never reports its own failures is not reporting
honestly. When a cell is lost to a harness bug rather than to the system under test, it belongs
here, with `owner: harness` on the corresponding finding, so it is never read as a defect in
the design system.

## 8. Validity limits

What this report does not support:

1. **Single repetition.** Every cell is one sample. Nothing here distinguishes a systematic
   effect from model variance. Three repetitions are the minimum to attribute a context
   difference to the context rather than to the roll.
2. **No bare context.** Lift is unmeasurable without one, so the composite reports a
   `partial-behavioral` basis. It must not be read against a composite computed on a
   different basis.
3. **The rubrics are the benchmark author's.** Judgment carries the heaviest weight and
   measures generic UI judgment, not conformance to this system's own composition rules.
4. **One model, one agent.** No claim is made about how other models behave.

## 9. Recommendations

**Low cost, do now:**

1. Add an `AGENTS.md` at the system root (5.1). Highest-leverage single asset; every guided
   context begins there. Name the `Input` alias while writing it (5.3).
2. Enable `outputReferences` in the token build (5.2). Recovers the semantic layer in the
   shipped artefact.
3. Name `Pagination` explicitly in the skill bundle (5.4).

**Needs a decision:**

4. Encode destructive-action hierarchy as an explicit composition rule (5.5). This is a
   question about what the system asserts, not a documentation fix.

**Further measurement:**

5. Run a profile that includes a `bare` context and three repetitions, for a defensible
   composite and a real Lift figure.

## Appendix A - Task suite

2 intent-level tasks, none naming a component:

`data-table-pagination` - `destructive-confirmation`

## Appendix B - Reproducing

```bash
# the harness lives outside the design system repo
cd open-design-system-bench
npx tsx src/cli.ts doctor
npx tsx src/cli.ts extract
npx tsx src/cli.ts audit --system my-system
npx tsx src/cli.ts run --profile <profile> --label <label>
npx tsx src/cli.ts audit --system my-system --run runs/20260101-000000-example
```

Re-scoring without re-running agents, which costs nothing:

```bash
npx tsx src/cli.ts grade --run runs/20260101-000000-example
```

Regenerating this report's computed sections, and checking it:

```bash
npx tsx src/cli.ts report --stats --run runs/20260101-000000-example --system my-system
npx tsx src/cli.ts report --validate <this file>
```

Artefacts per cell: `diff.patch`, `transcript.jsonl`, `grades.json`, `judge.json`, and the full
generated `workspace/src`.
