# open-design-system-bench — agent instructions

You are working on **open-design-system-bench**: a benchmark that answers "how AI-ready is your design
system?" by running coding agents against a real component library and grading the output, plus a
static `audit` that scores AI-readiness in seconds with no API key. This file is the working
context: what exists, how to work on it, and the decisions not to relitigate. The plan, the
phase status, and the list of next tasks live in `ROADMAP.md`, which is the authoritative
source and is not part of the shipped repo.

## Distribution

- **GitHub-first**: users clone, `npm install`, and run `npx tsx src/cli.ts ...`.
  There is no npm package and no build step. `package.json` has `private: true` on purpose —
  do not publish, do not add a `bin`, do not add a build pipeline.
- Nothing in this repo is specific to one design system. Every check, fixture, grader, and
  default resolves from the user's own `systems.config.json`. If you find yourself hardcoding a
  component name, package name, or provider id, make it a config field instead.

## What exists and works (verified 2026-08-27, full test suite green)

- **Fully system-agnostic.** Systems are arbitrary string ids declared in
  `systems.config.json` (`{ "systems": { "<id>": SystemConfig } }`). The root config ships a
  `my-system` placeholder that `init` fills in. A config may declare `"dataDir"` to ship its own
  committed catalog/token snapshots. Global CLI options:
  `--config <path>` and `--tasks-dir <path>`.
- **The `audit` command.** Seven static Tier-0 checks (enablement surface, catalog
  quality, export hygiene, vocabulary convention-distance, token machine-readability,
  deprecation legibility, docs greppability) in `src/audit/checks/`, assembled into the
  AI-Readiness Score (`src/audit/score.ts`: Surface + Lift/Ceiling/Engagement/
  Vocabulary-behavioral, the behavioral four computed only when `--run <dir>` provides a
  results.json). `src/audit/convention-lexicon.json` is an **empirical data artifact**: names AI
  models invented across 898 graded generations (6 model configs, 2 production design systems).
  Do not edit its data by hand; extend it only with new mined evidence.
- **Three catalog strategies.** `docgen` (react-docgen-typescript over a walked barrel),
  `catalog-json` (the system ships this repo's own catalog shape), and `stencil`
  (`src/extract/catalog-stencil.ts`, reading the docs.json a Stencil build emits from its
  `docs-json` output target). A Stencil library defeats docgen on three counts and none are
  fixable in the resolver: its barrel re-exports a *virtual* `./components` module the compiler
  synthesizes at build time, its components are `@Prop()` classes rather than React components,
  and its component dirs nest arbitrarily deep. `stencil` records the custom-element tag as the
  documented export and the derived PascalCase class name as a second gradeable spelling in
  allExports only, plus kebab attribute and event-handler prop aliases in allPropsByExport only.
  Do not promote those alias spellings into `components[].exports`: that array is the
  *documented* surface the audit's per-export checks read, and doubling it made docs-greppability
  report every PascalCase name as undocumented (which it always is: a Stencil system's prose
  documents the tag). Staleness is checked by scanning componentsSrc recursively for `@Component(`
  tags, not by the flat readdir `catalog-json` uses.
- **`foundationsCss` takes one path or a list.** Plenty of systems ship one file per token
  category with no aggregate CSS entry point (Admiral: nineteen files under `packages/tokens/css/`,
  aggregated only by a `.scss` that `@use`s them). A list is read as one concatenated document, so
  cssVars/utilities are the union and cssHash covers the lot. Go through `readFoundationsCss` /
  `foundationsCssPaths` / `describeFoundationsCss` in `src/config.ts` rather than reading
  `cfg.foundationsCss` directly, so the single- and multi-file shapes cannot drift apart.
- **`init`, npm-consume fixtures, and `leaderboard`.** The `init` wizard
  (`src/init/wizard.ts`) works interactively and non-interactively, wired as the `init` CLI
  command. `consume: 'npm'` fixture mode uses the generic template in `fixtures/npm-app/`, with
  prepared installs landing in gitignored `fixtures/.prepared/`; it is proven end-to-end against
  `@radix-ui/react-slot`. The `leaderboard` command (`src/report/leaderboard.ts`) merges
  `audit --json` files into a self-contained ranking page.
- **The extractor handles all three real-world barrel shapes.** `export * from './dir'`, named
  value re-exports (`export { X } from './dir'`), and bare .tsx file modules carrying JSX are all
  covered by the docgen extractor and the export-hygiene check. Directories named `internal` or
  `private` count as deliberate encapsulation, not export-hygiene failures.
- **Benchmark core** (inherited, all working): task suite → fixture workspace (git-diff based) →
  agent generation → six graded dimensions (imports, apiFidelity, tokenDiscipline, a11yStatic,
  compile, judgment) → composite score + worst-case gate → self-contained report.html →
  `compare` and `ci` with frozen baselines. Profiles smoke/small/medium/full. Pause/resume
  (`--resume`, `--retry-errored`, `--wait`) with usage-limit detection and incremental
  persistence. Multi-provider: agentic generation via the `claude` CLI (BYO `ANTHROPIC_API_KEY`
  or gateway via `ANTHROPIC_BASE_URL`), single-shot generation via any OpenAI-compatible or
  Anthropic-compatible endpoint (`providers` map in `bench.config.json`, qualified model strings
  like `--models "openai:gpt-5.2"`), judge on either path. `.env` is auto-loaded (gitignored;
  `.env.example` documents the variables).

## Conventions (follow these)

- ESM TypeScript, strict, run via `tsx`. Local imports use **explicit `.ts` extensions**.
- No new runtime dependencies without a strong reason — the provider clients are plain `fetch`
  by design; the graders use @babel/parser; that is the spirit.
- Tests are offline: node:test via `tsx --test`, mock HTTP servers on 127.0.0.1, synthetic
  configs in temp dirs. **Never call the live `claude` CLI or any provider in tests.**
- npm quirk: if `npm install` hits a cache permission error, add
  `--cache .npm-cache --no-fund --no-audit` (dir is gitignored).
- Verification loop after any change:
  `node_modules/.bin/tsc --noEmit -p tsconfig.json` and
  `node_modules/.bin/tsx --test src/**/*.test.ts` (the whole suite stays green), plus
  `npx tsx src/cli.ts validate-tasks` and, when audit code changed,
  `npx tsx src/cli.ts audit` against a configured system.
- Benchmark runs (`run`, `judge`, doctor's live probe) cost real LLM money — never start one
  without the operator asking.
- Writing style for docs/reports: no em dashes, straight quotes, sentence-case headings.
- The a11yStatic grader's accessible-name vocabulary is configurable via `SystemConfig.a11y`,
  merged over conventional defaults. Extend the defaults rather than hardcoding a new component
  name.
- Context levels are the fixed union `bare` | `agents-md` | `skill`. `mcp` is reserved and
  unimplemented, so do not pass it.

## Design decisions with reasons (don't relitigate casually)

- **Gate on the worst dimension, never the mean** — identical composites hide opposite failure
  modes (measured: engage-and-err vs avoid-the-system vs architect-and-collapse).
- **Oneshot (api-oneshot) and agentic (claude-code) cells are never ranked against each other**;
  the provider prefix keeps them in separate report columns. Agentic cells cost ~80x more and
  see compiler feedback; single-shot cells do not.
- **Hidden ground truth**: task prompts never name components; `validate-tasks` lints for leaks.
  `hiddenExpectations` is optional (the starter tasks omit it).
- **Extraction never trusts hand-written API lists**: public API = root barrel ∪ package.json
  exports; stale catalogs are refused (this rule has found real unexported components twice —
  components that a team believed were public but were never exported).
- **"Ignored the design system" is a first-class metric** — a model that avoids the system passes
  every API gate while being the worst outcome.
- **Tier thresholds** in `src/audit/score.ts` (AI-native ≥70 / Invested ≥40) are documented
  defaults awaiting recalibration from the reference-run distribution.
- **Written reports split a fixed data layer from a free interpretation layer.** `report --stats`
  generates every number and every computed section; `report --validate` re-renders them and
  requires a byte match, and rejects any figure in agent prose that does not trace to computed data
  or to a declared `citedFigures` entry. What a report *concludes* is never constrained: coverage
  and grounding are enforced, conclusions are not. Do not add gates that dictate findings.
- **Finding ids name a cause and stay stable across reports.** That is the whole mechanism by which
  a system's evolution becomes visible. `report --stats --since <previous report>` exists to carry
  them forward; a renamed id silently breaks history.

## Map

```
systems.config.json      systems registry (--config to swap in another)
bench.config.json        profiles, defaults, providers, ci thresholds
tasks/                   10 domain-neutral starter tasks (YAML)
fixtures/                source-app (generic source-alias), npm-app (generic npm-consume)
src/cli.ts               all commands: doctor|init|extract|validate-tasks|run|grade|judge|
                         report|compare|leaderboard|ci|prune|audit
src/config.ts            config + .env loading, dir resolution
src/types.ts             every shared contract (SystemId, SystemConfig, CellSpec, EvalResult, ...)
src/extract/             catalog-docgen, catalog-json, catalog-stencil, tokens, normalize
src/tasks/               schema + load + suite validation (leak linter)
src/run/                 matrix, fixture, collect, runner (pause/resume lives here)
src/agents/              claude-code (agentic), api-oneshot (single-shot), codex (stub), errors
src/providers/           fetch clients (openai/anthropic wire formats), model-spec, pricing
src/grade/               ast, mechanical/* (5 dimensions), judge, score
src/report/              aggregate, html, compare, leaderboard, ci, shared; written-report
                         contract: stats (every computed number + the fixed outline),
                         document (parse + the validate gates), json-schema-lite, figures
src/audit/               7 Tier-0 checks, score assembly, convention-lexicon.json
src/init/                wizard
schema/                  report.schema.json - the written-report front-matter contract
docs/reports/            README, report-authoring.md (the contract in prose),
                         report-example.md; generated per-system reports land
                         here and are gitignored
.claude/skills/          ds-bench-report: drives the report-authoring agent
ROADMAP.md               the plan: phase status, next tasks, eval catalog (internal, not
                         part of the shipped repo)
```
