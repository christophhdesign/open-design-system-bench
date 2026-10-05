# Changelog

What changed in open-design-system-bench, newest first. The project is GitHub-first (clone and run, no npm package), so dates are the record rather than published versions.

## 1.3.0, 2026-10-05

Field feedback from running the audit and smoke tests against a production React system built with Vite, plus the tooling asked for at the talk: a screenshot gallery, hard tasks, and a bare run that is really bare.

### Added

- **`tsconfig` system field.** Points the `docgen` strategy at the tsconfig that actually compiles the components. Without it, a solution-style root `tsconfig.json` (Vite's default: `"files": []` plus `references`) is followed to the reference that includes `componentsSrc`, and a warning names the file used. Before, the root's empty options left path aliases unresolved and the catalog came back with almost no props, which on the reporting system cost 5.7 audit points.
- **`gallery` command and `ds-bench-gallery` skill.** `gallery [<runDir>...]` renders a UI gallery: a screenshot of what every ok cell rendered (each workspace is `vite build`-ed and captured with headless Chrome, cached as `screenshot.png` in the cell dir, with build failures shown on the card), rows per context level, cards per rep with score, gate, turns, cost and a dimensions drill-down, and a task picker, gate filter, context toggles and size slider. Several runs get a run picker. No new dependency: Chrome, Chromium or Edge on the machine, or `CHROME_PATH`.
- **Provider `stream` flag.** `"stream": true` on an `openai`-kind provider streams the completion (SSE) and reassembles it client-side, for gateways that buffer whole completions and time out on long generations (HTTP 408 after 200 s on one gateway, which single-shot cells on the hard tasks exceed).
- **Four hard tasks, opt-in.** `tasks/hard/` holds `bulk-member-actions`, `async-lookup-states`, `inline-profile-editing` and `keyboard-action-finder`, each combining several design-system patterns with state, async or keyboard work (selection with an indeterminate master control plus a confirmed bulk action; four async states plus stale-request handling; per-field edit mode plus an unsaved-changes guard; a keyboard-driven finder with focus return and listbox semantics). Prompts were checked against nine production catalogs for name leaks. A profile's `"*"` still means the ten starter tasks, so existing baselines are unchanged; `--hard` (or `"hard": true` in a profile) adds them, and the new `hard` profile is exactly that across all three contexts.

### Fixed

- **Bare cells were not bare.** The agent loaded the operator's `~/.claude/CLAUDE.md`, user skills, plugins, hooks, effort level and auto-memory, and, since `runs/` sits inside this repo, the bench's own `CLAUDE.md` and `AGENTS.md`. Cells now pass `--setting-sources project` plus `claudeMdExcludes` for every directory above the workspace, so the workspace's own `CLAUDE.md` and `.claude/skills` are the only context left. `--restricted` was considered and rejected: it also drops those workspace files, which would make `agents-md` and `skill` identical to `bare`. The judge now runs with `--safe-mode` for the same reason. Results from earlier runs carried this context, so expect shifts when comparing against an older baseline.
- **`pricing-catalog.json` is documented.** The optional model catalog at the package root (a gateway's `GET /v1/models` shape) supplies each model's real `max_tokens` and prices. Without it, single-shot cells send a 128k budget that Vertex-hosted Gemini rejects with HTTP 400, and cost stays n/a; that 400 now carries a hint naming the file. The file is gitignored.
- **Single-shot JSON with a stray leading brace parses.** One open-weights model behind a gateway answers `{` on its own line before the real `{"files": ...}` object (3 of 4 hard-task cells, finish_reason=stop, payload otherwise complete). `extractJsonPayload` now skips that brace, the same way it already tolerates fences and prose, so the cell is graded instead of counted as an agent error.
- **tokenDiscipline reads style sheets.** `.css` and `.scss` files the agent writes are collected and their declarations checked for raw hex/rgb colors and px/rem values, with comments, at-rules and selectors skipped, and `@apply` arbitrary values flagged. A system that keeps its styling in SCSS used to score 100 here whatever the stylesheet contained.

## 2026-09-07

Web-component systems, Stencil catalogs, and several field-test fixes from pointing the harness at production libraries that are not React component trees.

### Added

- **Web-component systems.** `SystemConfig.componentModel` is `"react"` (default) or `"custom-elements"`. The latter selects `fixtures/custom-elements-app`, grades dashed JSX tags against the catalog (no per-component import required), and generates `src/system-elements.d.ts` at provision so invented attribute values fail the compile gate. Stencil, Lit, and hand-rolled custom-element registries are in scope. ([#14](https://github.com/christophhdesign/open-design-system-bench/pull/14))
- **Stencil catalog strategy.** `catalogStrategy: "stencil"` reads the `docs.json` a Stencil build emits from its `docs-json` output target. The documented export is the custom-element tag; PascalCase class names and kebab/event aliases stay in the gradeable surface only, so docs-greppability does not treat class names as undocumented. The audit can load a Stencil catalog live, not only a pre-extracted snapshot. ([#11](https://github.com/christophhdesign/open-design-system-bench/pull/11))
- **`foundationsCss` as a list.** Token files split by category (one production system ships nineteen) are read as one concatenated document. A configured-but-unreadable list fails loudly instead of extracting an empty token set. ([#11](https://github.com/christophhdesign/open-design-system-bench/pull/11))
- **`extraDocs` globs.** An entry containing `*` expands, and matches keep their path under `docs/` so a hundred `readme.md` files do not flatten onto one another. ([#13](https://github.com/christophhdesign/open-design-system-bench/pull/13))

### Changed

- **Skill injection.** A configured path that is a directory of skill bundles is copied so each bundle lands at `.claude/skills/<name>/SKILL.md`, which is where agents look. A path that names a single bundle still copies as before. On one field-tested system this made eighteen skills visible that had been nested one directory too deep. ([#13](https://github.com/christophhdesign/open-design-system-bench/pull/13))
- **Generic source-app follows your layout.** `componentsSrc` and `foundationsCss` are substituted into the fixture instead of assuming `packages/components/src`. Vite aliases for the package name are anchored regexes, so deep imports such as `@scope/pkg/button` resolve to the subpath rather than `index.ts/button`.
- **Audit honesty.** Export hygiene returns `null` (weight redistributed) when it cannot measure, instead of a constant dressed as a grade. Custom-element layouts are reported as inapplicable; unreadable layouts as a warning. Deprecation scoring credits `MIGRATION.md` / `UPGRADING.md` and version headings such as `## 30 -> 31`, not only `CHANGELOG*.md` and semver triples. Existing leaderboard numbers can shift. ([#12](https://github.com/christophhdesign/open-design-system-bench/pull/12))
- **`init` infers `componentModel: "custom-elements"`** for a stencil catalog so onboarding does not land on the React fixture.

### Fixed

- apiFidelity resolves only dashed tags against the catalog in custom-elements mode, so a local PascalCase component is not graded as system usage.
- Generated element types omit React host keys before intersecting, so a catalog prop such as `hidden` does not collapse to `never`, and `key` / `ref` work on lists of elements.
- Custom elements accept `class` alongside `className`, matching React 19 and HTML-shaped docs.
- Audit tests no longer inherit global commit signing in their synthetic git repo. ([#10](https://github.com/christophhdesign/open-design-system-bench/pull/10))

## 2026-08-31

### Added

- **Written AI-readiness reports.** `report --stats` emits every computed number and the fixed outline as finished markdown. `report --validate` re-renders those blocks and requires every figure in the prose to trace to computed data or a declared `citedFigures` entry. Findings, recommendations, and conclusions stay free. Finding ids are stable across reports so `--stats --since` can carry history forward. Contract: [`schema/report.schema.json`](schema/report.schema.json), authoring guide in [`docs/reports/`](docs/reports/). ([#8](https://github.com/christophhdesign/open-design-system-bench/pull/8))

### Changed

- Generated reports live under `docs/reports/<system-id>/` and are gitignored (output about your system, same reasoning as `runs/`).
- System-specific fixture templates stay out of the repo. `.gitignore` keeps the generic templates and ignores every other directory under `fixtures/`.

### Fixed

- Numeric grounding no longer treats ordered-list markers (`1.`, `2.`) as claimed figures.

## 2026-08-26 – 2026-08-28

Initial public release of the harness, plus grading fixes from running it against Chakra UI and Mantine.

### Added

- Plug-in benchmark: intent-level tasks, isolated fixture workspaces, six graded dimensions, composite score with a worst-dimension gate.
- Static `audit` and the AI-Readiness Score (seven Tier-0 checks, optional behavioral sub-scores when `--run` is given).
- `init` wizard, `consume: "npm"` fixtures, `leaderboard`, pause/resume, multi-provider generation and judging.
- Ten domain-neutral starter tasks. Generic `source-app` and `npm-app` fixtures.

### Fixed

- Namespace re-exports (`export * as Dialog from './namespace'`) now contribute the head name to `allExports`. Chakra UI v3 has 58 of these; generations importing them were graded as ignoring the system. ([#5](https://github.com/christophhdesign/open-design-system-bench/pull/5), [#6](https://github.com/christophhdesign/open-design-system-bench/pull/6), [#7](https://github.com/christophhdesign/open-design-system-bench/pull/7))
- `displayName` literals such as Mantine's `'@mantine/core/Paper'` no longer hide the exported symbol from docgen, so extractable components keep their prop lists.
- Usage-limit phrasing without "at" (`resets 2am`) pauses the run instead of burning remaining cells as agent errors.
- CI: public npm lockfile, test glob expansion, report demo HTML written to `os.tmpdir()`. ([#2](https://github.com/christophhdesign/open-design-system-bench/pull/2), [#3](https://github.com/christophhdesign/open-design-system-bench/pull/3), [#4](https://github.com/christophhdesign/open-design-system-bench/pull/4))
