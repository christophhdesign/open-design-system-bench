# open-design-system-bench

![A grid of compass needles on a dark field. On the left they follow one current; on the right they drift into their own directions.](docs/hero-field.svg)

**How AI-ready is your design system?** A plug-in benchmark that runs coding agents against your
component library and grades the output. Built against a production design system and generalized
for any React + TypeScript component library.

Benchmarks how well AI coding agents follow **your** design system, per the methodology in
["Design Systems Need Evals"](https://blog.murphytrueman.com/design-systems-need-evals/):
held-constant, **intent-level task prompts** (which never name the expected component — hidden
ground truth) are run through a headless coding agent inside an isolated fixture workspace, and
the generated code is graded by **mechanical checks** against the system's real component APIs and
tokens plus **LLM-as-judge rubrics** for the judgment calls no parser can make.

The headline output is a matrix: **system × context level × model**, answering *"how much does
each layer of agent context (nothing → AGENTS.md → skills/docs) actually improve design-system
compliance?"* — tracked over time so regressions in docs, mappings, or models show up as score
drops, not as production surprises.

The harness ships with a **generic starter config** (`systems.config.json`, a single fillable
placeholder system) and the `init` wizard to fill it in. Nothing here is specific to one design
system: point it at yours and every check, fixture, and grader resolves from your own config.

## What gets measured

Each cell produces an `EvalResult` (same `Gate`/score contract as `eval-harness/`):

| Dimension | Weight | What it checks | Hard gate |
|---|---|---|---|
| imports | 0.10 | only the system's package, react, and local files are imported | foreign UI lib → review/fail |
| apiFidelity | 0.25 | no hallucinated components (imports ⊆ extracted catalog), no invented props, optional cross-system contamination sentinels (e.g. `iconStart` vs `iconLeading`, only relevant when benchmarking more than one system side by side) | hallucinated component → **fail** |
| tokenDiscipline | 0.15 | no raw hex/rgb, no `bg-[#…]`/`w-[137px]` arbitrary values, no hardcoded inline-style colors | — |
| a11yStatic | 0.10 | AST-based subset: accessible names on form controls / icon buttons, img-alt, positive tabindex, click-without-key, label association, valid `aria-*`, autofocus, anchor validity | — |
| compile | 0.10 | `tsc --noEmit` against the fixture (aliased to the system's **source**) | error → **fail** |
| judgment | 0.30 | per-task rubrics judged by a separate model (`claude -p --json-schema`, default haiku), blind to cell config | critical rubric fail → review |

Ground truth is **extracted, never hand-written**: `catalogStrategy: "docgen"` runs
react-docgen-typescript over your `componentsSrc` (public API = root barrel ∪ package.json subpath
exports); `catalogStrategy: "catalog-json"` reads a pre-built machine-readable catalog file your
own repo already ships (`catalogFile`, extraction refuses a stale one). Tokens are parsed from
your system's foundations CSS (`foundationsCss`, optional — omit it and token/contamination
checks are simply skipped, with a `doctor` warning).

## Prerequisites

- node ≥ 20
- `claude` CLI installed and logged in (generation + judging both run through it; no API keys)
- Your design system's repo(s) checked out and with their own deps installed — path(s) declared
  in `systems.config.json`, overridable per-system via each entry's `rootEnv`
- `npm install` in this package. If npm's default cache errors (sandboxed environments), add
  `--cache .npm-cache`.

## Quickstart

0. **Or skip the manual edit and run the wizard.** `npx tsx src/cli.ts init` interrogates your
   system (id, consume mode, package spec or repo root, CSS entry, docs files, catalog strategy),
   writes/merges the entry into `systems.config.json`, scaffolds three starter tasks into `tasks/`
   if it's empty, and prints doctor-grade ok/warn checks plus next steps. It never clobbers other
   systems already in the config, or overwrites an existing task suite. (The wizard logic lives in
   `src/init/wizard.ts`; the `init` CLI command wires flags to it.)

1. **Point the harness at your design system.** Edit `systems.config.json` — it ships with one
   placeholder system, `"my-system"`, whose fields (`root`, `componentsSrc`, `componentsPkg`,
   `catalogStrategy`, …) are meant to be filled in. See [SystemConfig fields](#systemconfig-fields)
   below. Rename `"my-system"` to whatever you like, but keep `bench.config.json`'s profiles'
   `"systems"` lists in sync if you do.

```bash
npm run doctor            # verify the configured system(s), catalogs, claude CLI, task suite
npm run extract           # regenerate catalogs/ + tokens/ from your system's repo
npm run validate-tasks    # lint the task suite (incl. prompt-leak check) against tasks/*.yaml —
                           # ten domain-neutral starter tasks, no hiddenExpectations required

npx tsx src/cli.ts run --profile smoke            # 2 cells, ~5 min — sanity check
npx tsx src/cli.ts run --profile small --label w35   # weekly regression
npx tsx src/cli.ts run --profile medium --label aug  # monthly sweep
npx tsx src/cli.ts run --profile full --label q3     # quarterly baseline
```

Cell counts in the profiles table below assume the default single-system template; each profile's
`"systems"` array (in `bench.config.json`) determines the actual multiplier — add more systems
there (or pass `--systems a,b`) to benchmark several at once.

### SystemConfig fields

| Field | Required | Meaning |
|---|---|---|
| `root` | yes | Absolute path to the system's repo checkout |
| `rootEnv` | yes | Env var name that can override `root` (e.g. for CI) |
| `componentsSrc` | yes | Path (relative to `root`) to the components source dir |
| `componentsPkg` / `foundationsPkg` | yes | The npm package names your system's components/tokens are imported from |
| `foundationsCss` | no | Path to the foundations CSS file tokens are parsed from; omit if none |
| `catalogStrategy` | yes | `"docgen"` (extract via react-docgen-typescript) or `"catalog-json"` (read a pre-built catalog file) |
| `catalogFile` | `catalog-json` only | Path to that pre-built catalog JSON |
| `agentContext.agentsMd` | yes | Files copied in as `AGENTS.md`/`CLAUDE.md` at context level `agents-md` |
| `agentContext.skillDirs` / `agentContext.extraDocs` | no | Skill bundles / extra reference docs injected at context level `skill` |
| `contamination` | no | Cross-system sentinel props + typography casing — only meaningful with 2+ systems configured |
| `fixtureTemplate` | no | Path to this system's fixture template app. Source mode falls back to `fixtures/<systemId>-app`, then the generic `fixtures/source-app`; `npm` mode uses `fixtures/npm-app` |
| `consume` | no | `"source"` (default) or `"npm"` — see [npm-consume mode](#npm-consume-mode) below |
| `packageSpec` | `npm` only | npm install spec, e.g. `"@acme/ui"` or `"@acme/ui@^2.0.0"`; defaults to `componentsPkg` |
| `cssEntry` | no | Import specifier for the system's stylesheet, e.g. `"@acme/ui/styles.css"`; optional, `npm` mode only |
| `fixturePins` | no | Extra npm specs installed alongside `packageSpec`, for peer-dependency conflicts (a library still on React 18 needs `["react@^18.3.1", …]` against the template's React 19) |
| `a11y` | no | Your accessible-name vocabulary for the a11yStatic grader (`controls`, `iconOnly`, `labels`, `formContext`, `placeholderNamed`). Merged with conventional defaults, so declare only what differs |

## npm-consume mode

`consume: "npm"` is for design systems you don't (or can't) have checked out locally — you only
have the published package. Instead of aliasing the fixture at a source tree (the `"source"`
default), `prepareTemplate` copies the generic `fixtures/npm-app` template into a per-system
prepared workspace (`fixtures/.prepared/<systemId>-app`, gitignored) and runs two `npm install`s
there: the template's own deps (react, vite, …), then `packageSpec` (or `componentsPkg` if
`packageSpec` is omitted). From then on `provisionWorkspace` works from that prepared dir exactly
as it does for `"source"` mode — imports resolve through real `node_modules`, no
`__SYSTEM_ROOT__` substitution needed. If `cssEntry` is set, `src/main.tsx` imports it; if omitted,
the placeholder import line is removed rather than left dangling.

If the package's peer dependencies conflict with the template's React version, set
`fixturePins` to extra install specs resolved together with the package. A library still on
React 18 needs pinning against the template's React 19:
`"fixturePins": ["react@^18.3.1", "react-dom@^18.3.1", "@types/react@^18.3.12", "@types/react-dom@^18.3.1"]`.

```json
{
  "systems": {
    "acme": {
      "root": "/absolute/path/to/wherever/you/keep/docs",
      "rootEnv": "OPEN_DESIGN_SYSTEM_BENCH_ACME_DIR",
      "componentsSrc": "src",
      "componentsPkg": "@acme/ui",
      "foundationsPkg": "@acme/ui",
      "catalogStrategy": "docgen",
      "consume": "npm",
      "packageSpec": "@acme/ui@^2.0.0",
      "cssEntry": "@acme/ui/styles.css",
      "agentContext": { "agentsMd": ["AGENTS.md", "README.md"] }
    }
  }
}
```

`root` still matters in `npm` mode — it's where `agentContext.agentsMd`/`skillDirs`/`extraDocs`
are read from — it just no longer needs to be the design system's own repo; point it at wherever
you keep AGENTS.md/README.md-style guidance for this system (the `init` wizard defaults it to the
current directory). `catalogStrategy` still has to be `"docgen"` or `"catalog-json"` (there's no
`"none"` in the schema); if you don't have an extraction strategy figured out yet, `init` persists
`"docgen"` as a schema-valid placeholder and warns loudly that it needs editing before `extract`
will do anything useful.

## The static audit and the AI-Readiness Score

No API key, no LLM, seconds not minutes: `audit` runs seven static Tier-0 checks over a
configured system (enablement surface, catalog quality, export hygiene, vocabulary
convention-distance, token machine-readability, deprecation legibility, docs greppability)
and assembles them into the AI-Readiness Score with a tier (AI-native >= 70, Invested >= 40,
Emerging below).

```bash
npx tsx src/cli.ts audit                              # every configured system, human-readable
npx tsx src/cli.ts audit --system my-system --verbose # one system, all findings
npx tsx src/cli.ts audit --json > audit.json          # machine-readable, for leaderboard
npx tsx src/cli.ts audit --run runs/<id>              # adds the four behavioral sub-scores
```

Without `--run` the composite is surface-only and labeled as such: static checks are a
weaker kind of evidence than measured agent behavior, and the report never blurs the two.
With a run, four behavioral sub-scores join the composite: Lift (guided minus bare score),
Ceiling (guided quality and pass rate), Engagement (share of cells that actually used the
system), and Vocabulary (whether hallucinated names at least follow convention).

`leaderboard` merges any number of `audit --json` files into one self-contained ranking page:

```bash
npx tsx src/cli.ts leaderboard audit-a.json audit-b.json --out leaderboard.html
```


## Profiles: pick the run for the question

Cell counts below assume the default single-system template (`"systems": ["my-system"]` in every
profile). Configuring more systems (or passing `--systems a,b`) multiplies each row by however
many systems are in scope — two configured systems doubles them.

| Profile | Matrix (per system) | Cells (1 system) | When | What it answers |
|---|---|---|---|---|
| `smoke` | 2 contexts × 1 task × 1 rep | 2 | after harness changes | is the pipeline alive |
| `small` | `skill` × 5 tasks × 1 rep | 5 | **weekly**, and on docs/system PRs | did our latest changes regress agent compliance vs the frozen baseline |
| `medium` | 2 enabled contexts × 10 tasks × 1 rep | 20 | **monthly** | full task coverage across the enabled guidance levels |
| `full` | 3 contexts × 10 tasks × 3 reps | 90 | **quarterly** + before/after big changes (model updates, MCP) | the complete picture with means ± spread; the baseline everything else compares against |

Roughly ~$1.50/cell and 2–5 min/generation at concurrency 2 (varies by model and task).

The three reps exist only in `full`: agents are stochastic, so single-rep scores per cell are
directional while the baseline's means carry the error bars. `ci` compares per (cell × task), so a
`small` or `medium` run gates cleanly against a frozen `full` baseline — only the overlapping
cells are compared. The `small` task list is the five most discriminating tasks (critical rubrics,
clear component-choice traps); rotate it if a different area gets risky.

Every run lands in `runs/<timestamp>-<label>/` with `manifest.json`, `results.json`,
`report.html`, and per-cell artifacts (`diff.patch`, `transcript.jsonl`, `grades.json`,
`judge.json`, the generated `workspace/src`). Serve reports via the workspace launch config
`open-design-system-bench` → http://localhost:4189.

Useful during iteration (no agent re-runs — they re-score stored diffs):

```bash
npx tsx src/cli.ts grade --run runs/<id>     # re-run mechanical graders only
npx tsx src/cli.ts judge --run runs/<id> --judge-model sonnet --judge-samples 3
npx tsx src/cli.ts compare runs/<a> runs/<b> # side-by-side deltas (e.g. before/after a docs change)

npx tsx src/cli.ts prune                     # preview only — nothing is deleted
npx tsx src/cli.ts prune --apply --keep 1    # drop workspaces from older finished runs
npx tsx src/cli.ts prune --apply --older-than 7d
npx tsx src/cli.ts prune --apply --run runs/<id>
```

`prune` is manual (the runner never calls it). It deletes per-cell `workspace/` copies after you are done retrying. In-flight runs and runs that still have timeout / error / pending cells are skipped so `--resume` / `--retry-errored` still have a tree to work in. Pass `--force` if you want to strip those anyway — retry still works, it provisions a fresh workspace. `--deep` also drops `files/` and breaks `grade --run`.

## Written reports

`report.html` is a heatmap for reading a single run. A **written report** is the other artifact: the
document you hand to a design-system team, and the record you compare against next quarter.

The artifact is markdown. It carries YAML front matter conforming to
[`schema/report.schema.json`](schema/report.schema.json), which is what makes a folder of reports
machine-comparable over time.

```bash
# 1. compute every number the report needs
npx tsx src/cli.ts report --stats --run runs/<id> --system <system-id>   --since reports/<system-id>/<previous>.report.md

# 2. write reports/<system-id>/<YYYY-MM-DD>-<profile>.report.md

# 3. check it
npx tsx src/cli.ts report --validate reports/<system-id>/<date>-<profile>.report.md
```

Reports are written by an agent. The split that makes them trustworthy:

- **The data layer is fixed.** `--stats` emits the front matter and the computed sections
  (executive summary, config, extraction, axis primer, per-cell and by-context tables) as finished
  markdown. The author pastes them verbatim and never does arithmetic. `--validate` re-renders them
  and fails on a byte difference.
- **The interpretation layer is free.** Findings, notable results, validity limits and
  recommendations are the author's, and two authors will write them differently, the way two human
  analysts would.

`--validate` enforces grounding rather than conclusions. Every number in the prose must trace to a
computed value or to a `citedFigures` entry naming its source and method; every finding must cite a
cell, audit check or file that actually exists; and every hard failure and every low audit score
must be addressed by some finding. What the report *concludes* about each is never constrained.

Finding ids are the history mechanism: an id names a cause and stays stable across reports, so the
same defect is recognisable next quarter and can be carried forward as `fixed`. `--stats --since`
prints the previous report's ids for reuse. Two reports are numerically comparable only when their
`comparabilityKey` matches, which encodes profile, contexts, reps, consume mode and fixture.

Commit `reports/` and the history lives in git.

- [`docs/report-authoring.md`](docs/report-authoring.md) is the full contract.
- [`docs/report-example.md`](docs/report-example.md) is a complete worked example.
- `.claude/skills/ds-bench-report/` drives the authoring agent in Claude Code.

## Benchmarks & CI

```bash
npx tsx src/cli.ts ci --run runs/<id> --freeze          # freeze a baseline
npx tsx src/cli.ts ci --run runs/<newer>                # exit 1 on >5pt drop or gate worsening
npx tsx src/cli.ts ci --run runs/<id> --fail-on fail    # exit 1 on any hard-gate fail
```

Exit codes: `0` ok · `1` fail/regression · `2` usage/config error · `3` inconclusive (>20% of
cells errored — a green gate never means "we didn't measure"). Wire `extract && validate-tasks
&& run --profile smoke && ci` into your design system's CI to catch stale mappings the way the
article describes (a renamed prop should fail the suite, not ship).

## Pausing and resuming

A `full` matrix can run for hours, which is longer than a single Claude subscription's 5-hour
usage window. When the `claude` CLI starts failing with usage-limit signals (rate limits, "usage
limit reached", 429s, etc.), the run does **not** burn the rest of the matrix as errored cells —
it pauses gracefully:

- Every cell's result is written to `manifest.json` and `results.json` as soon as that cell
  settles, so the run directory is always resumable and `report.html` always reflects real
  progress, not just the final state.
- Once a usage limit is detected, no new cells are started. Any cell that hit the limit, plus any
  cell that never got to start, are marked `skipped` with `skipReason: "paused: usage limit —
  resume to run"` and `manifest.paused: true`. The CLI exits `3` and prints exactly how many
  cells are done, how many are pending, and the resume command to run.
- Resume with:

  ```bash
  npx tsx src/cli.ts run --resume runs/<paused-run-dir>
  ```

  This re-runs **only** the pending cells (a stale/partial workspace from the interrupted attempt
  is wiped and re-provisioned first), merges their results into the same run directory, clears
  `manifest.paused`, and regenerates `results.json` + `report.html`. Judge flags (`--judge-model`,
  `--judge-samples`, `--no-judge`) may be overridden at resume time; the profile itself always
  comes from the original run's stored manifest.
- Pass `--wait` to have the run sleep instead of finishing paused: it probes every 10 minutes with
  a cheap `haiku` no-tools call (a fraction of a cent) and automatically continues the pending
  cells as soon as credits are back, giving up (and finishing paused as above) after 8 hours.
- Because progress is persisted after every cell, a plain `ctrl-C` is resumable the same way — the
  cells that already finished are kept, and `--resume` picks up exactly where you left off.

## Timeouts and retries

A generation that exceeds its time budget is retried **once automatically** before being recorded
(`defaults.retryTimeouts` in `bench.config.json`; set `0` to disable). Timeouts are usually
transient — throttling near a usage window, or a slow exploration run — and the retry's cost is
accumulated honestly into the cell's `costUsd`. A cell that times out twice is recorded as
`timeout` and stays that way through a normal `--resume`; to give timed-out or errored cells
another chance after a run finishes, resume with:

```bash
npx tsx src/cli.ts run --resume runs/<dir> --retry-errored
```

Avoid running two matrices concurrently on one subscription: they share the same usage window and
starve each other into exactly these timeouts.

## Cost & time

A `full` run is *N* systems × 3 contexts × 10 tasks × 3 reps generations (minus per-system
inapplicable tasks) + as many judge calls — 90 generations for the default single-system template,
180 with two systems configured. At 2–5 min per generation, expect hours; the default
concurrency is 2 (`--concurrency`). Use `--tasks`, `--systems`, `--contexts`, `--reps 1` to scope
partial runs; `run --no-judge` skips judging (add it later via `judge --run`).

## Providers & bring-your-own-key

By default every cell generates through the `claude` CLI on whatever subscription/login the
operator already has — nothing below is required. These are opt-in ways to point generation or
judging at a different key, gateway, or model provider.

**All of the environment variables below can live in a `.env` file** in the package root instead
of shell exports: copy `.env.example` to `.env`, uncomment what you use, done. The CLI loads it
automatically at startup, variables already set in your shell take precedence, and `.env` is
gitignored so keys never reach the repo. `doctor` confirms when a `.env` was loaded and which
provider keys it sees (never the values).

**(a) Bill the claude CLI's own generation to an API key instead of a subscription window.**
Export `ANTHROPIC_API_KEY` before running — the claude-code adapter's `spawn()` already inherits
the process environment, so this needs no config changes:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npx tsx src/cli.ts run --profile smoke
```

**(b) Route the claude CLI's agentic generation through a gateway** (any byte-for-byte
`/v1/messages` passthrough) instead of api.anthropic.com directly. This keeps the full multi-turn,
tool-using claude-code adapter — only the wire endpoint changes:

```bash
export ANTHROPIC_BASE_URL=https://your-gateway.example
export ANTHROPIC_AUTH_TOKEN=$GATEWAY_API_KEY   # or ANTHROPIC_API_KEY=$GATEWAY_API_KEY
npx tsx src/cli.ts run --profile smoke
```

`doctor` reports when `ANTHROPIC_BASE_URL` is set, so a gateway-routed run is visible in the
environment check rather than silently different.

**(c) Benchmark a non-claude model or a gateway-hosted model via a qualified model string.** A
`provider:model` entry in `--models` (or `bench.config.json` profiles) is resolved against the
`providers` map in `bench.config.json`:

```json
"providers": {
  "anthropic": { "kind": "anthropic", "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  "openai":    { "kind": "openai",    "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
  "gateway":   { "kind": "openai",    "baseUrl": "https://your-gateway.example/v1", "apiKeyEnv": "GATEWAY_API_KEY" }
}
```

```bash
export OPENAI_API_KEY=sk-...
npx tsx src/cli.ts run --profile smoke --models "openai:gpt-5.2"

export GATEWAY_API_KEY=...
npx tsx src/cli.ts run --profile smoke --models "gateway:<model-or-alias>"
```

`kind: "openai"` means OpenAI-compatible chat completions (`POST {baseUrl}/chat/completions`,
structured output via `response_format: json_schema`); `kind: "anthropic"` means the Anthropic
Messages wire format (`POST {baseUrl}/v1/messages`, structured output forced via a single tool +
`tool_choice`). Add any other OpenAI-compatible gateway as a new entry in `providers` — no code
changes needed. A plain model name with no matching provider prefix (`sonnet`,
`claude-sonnet-5`) is unaffected and keeps generating through the claude CLI as before.

**(d) Judge with a different provider than the generator used**, independent of (c):

```bash
npx tsx src/cli.ts judge --run runs/<id> --judge-provider openai --judge-model gpt-5.2
```

requires that provider's `apiKeyEnv` to be set; omit `--judge-provider` (or pass `claude-cli`) to
keep the default claude CLI judge. `bench.config.json`'s `defaults.judgeProvider` sets the
run-wide default.

**(e) The comparability caveat.** A qualified model routes generation through `api-oneshot`: a
**single-shot, non-agentic** call — one completion, given a fixed context bundle (fixture
README, CLAUDE.md/AGENTS.md/DESIGN.md, up to ~40KB of `docs/`, the current
`src/task/index.tsx`), with no ability to browse the filesystem, run tools, or see compiler
feedback. That is a fundamentally different task from claude-code's multi-turn, tool-using,
explore-then-edit loop. **Do not compare `api-oneshot` cells to `claude-code` cells on
turns/duration/"agentic capability"** — only on the mechanical/judgment output scores, and even
then read the difference as "model + one shot of context" vs. "model + an agent loop", not as a
pure model-to-model comparison. The report keeps them visually distinct because the qualified
model string (e.g. `openai:gpt-5.2`) is baked into `CellSpec.model`, which `cellKey`/report
columns/baselines all key off of. `api-oneshot`'s `costUsd` is always left unset — gateways price
differently and none of the wire formats used here return a cost figure worth normalizing.

## Point it at your own system

`init` writes a `systems.config.json` entry for you; everything else keys off it.

```bash
npx tsx src/cli.ts init                        # describe your design system
npx tsx src/cli.ts doctor                      # verify config, catalogs, agent CLI
npx tsx src/cli.ts extract                     # build the catalog from source
npx tsx src/cli.ts audit                       # AI-Readiness Score, no API key
npx tsx src/cli.ts validate-tasks              # lint the task suite against your catalog
npx tsx src/cli.ts run --profile smoke         # 2-cell sanity pass (costs LLM money)
```

`--config` points at any `systems.config.json`-shaped file and `--tasks-dir` at any task suite dir;
both are global options accepted by `doctor`, `extract`, `validate-tasks`, `run`, `grade`, `judge`,
and `audit`. That is how you keep several configs side by side: a config may declare
`"dataDir": "data"` to ship its own committed `data/{catalogs,tokens}/` snapshots instead of the
top-level (generated, gitignored) `catalogs/`/`tokens/` dirs.

## Design notes

- Fixture workspaces consume each system **from source** via vite/tsconfig aliases
  (`__SYSTEM_ROOT__`, `__COMPONENTS_PKG__`, and `__FOUNDATIONS_PKG__` substituted at provision) —
  no build step needed; dist stubs are unusable outside their own repos. Source mode resolves
  `SystemConfig.fixtureTemplate`, then `fixtures/<systemId>-app` if you hand-rolled one, then the
  generic `fixtures/source-app`, so a fresh system works without writing a fixture. `consume: "npm"` systems instead consume
  a real npm install from `fixtures/.prepared/<systemId>-app` (gitignored) — see
  [npm-consume mode](#npm-consume-mode).
- Fixture baseline commits pass `-c commit.gpgsign=false`: these are disposable local scratch
  repos used purely as a diff mechanism for grading, never pushed.
- The generating agent gets Read/Glob/Grep/Edit/Write only — no Bash, no web — and
  `--strict-mcp-config` so project MCP servers never leak into a cell.
- Task YAMLs live in `tasks/` (or wherever `--tasks-dir` points); `hiddenExpectations` is optional
  and never shown to the generating agent — a task without it still runs, `validate-tasks` just
  warns that the judge will have no expected-components catalog excerpt for it. The starter tasks
  ship without `hiddenExpectations` (a neutral task authored against a stranger's system can't
  know its component names in advance); add them once you know which components a task should
  reach for in your system. Where your system genuinely lacks a component a task implies, the
  benchmark surfaces that rather than papering over it.
- `context: mcp` is **reserved for the next phase**: rerunning the same suite with a system's MCP
  server attached and comparing against a frozen baseline produces a before/after-MCP KPI.

## License

[MIT](LICENSE)
