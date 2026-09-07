# Changelog

What changed in open-design-system-bench, newest first. The project is GitHub-first (clone and run, no npm package), so dates are the record rather than published versions.

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
