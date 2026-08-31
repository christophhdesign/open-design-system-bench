# Writing an AI-readiness report

A report answers "how AI-ready is this design system, and what should we change?" for a specific
system at a specific commit. The artifact is one markdown file. It carries YAML front matter
conforming to [`schema/report.schema.json`](../schema/report.schema.json), which is what makes a
folder of reports comparable over time.

Reports are agent-authored. This document is the contract that authoring follows.

## The one rule

**The data layer is fixed. The interpretation layer is free.**

Every number, table and derived figure is machine-generated. You paste them in verbatim. You never
retype a figure and never do arithmetic.

What you conclude from those numbers is interpretation, and it is expected to vary: two analysts
reading the same run would write different findings, and that is fine. The gates enforce
**coverage** (you must address this data point) and **grounding** (your claim must cite something
real). They never dictate the conclusion.

## Workflow

```bash
# 1. Compute everything. --since is optional but strongly preferred: it carries
#    finding ids forward, which is what makes history work.
npx tsx src/cli.ts report --stats --run runs/<run-id> --system <system-id> \
  --since docs/reports/<system-id>/<previous>.report.md

# 2. Write the report to docs/reports/<system-id>/<YYYY-MM-DD>-<profile>.report.md

# 3. Check it. Loop until it exits 0.
npx tsx src/cli.ts report --validate docs/reports/<system-id>/<date>-<profile>.report.md
```

`--stats` prints four things: the computed front matter, the generated sections, the coverage list,
and advisory leads.

Before writing, read the artifacts behind every hard failure. For each cell that gated `fail`, read
`runs/<run-id>/cells/<cellKey>/<taskId>/rep<N>/diff.patch` and `grades.json`, and `judge.json` where
judgment is low. A finding written from the summary line alone will be shallow and probably wrong
about the cause.

## Structure

The outline is fixed, ordered and closed. `--validate` fails on a missing, renamed or reordered
heading. Sections marked generated are pasted from `--stats` and must byte-match.

| Section | Source |
|---|---|
| `## 1. Executive summary` | generated |
| `## 2. Methodology` | you: one or two sentences on how the system was treated |
| `### 2.1 What the benchmark does` | generated |
| `### 2.2 Configuration used` | generated |
| `### 2.3 Extraction results` | generated |
| `### 2.4 Fixture deviations` | you: how this run departed from the stock template, and why |
| `## 3. What each axis measures` | generated |
| `## 4. Results` | you: one line introducing the tables |
| `### 4.1 All cells` | generated |
| `### 4.2 By context` | generated |
| `## 5. Findings` | you |
| `## 6. Notable individual results` | you |
| `## 7. Harness defects` | you |
| `## 8. Validity limits` | you |
| `## 9. Recommendations` | you |
| `## Appendix A - Task suite` | generated |
| `## Appendix B - Reproducing` | generated |

Give each finding its own sub-heading under section 5, numbered `5.1`, `5.2` and so on, and set the
finding's `section` field to match. Generated sections may not carry sub-headings.

[`report-example.md`](report-example.md) is a complete worked example on a synthetic system.

## Numbers

`--validate` reads every number in your prose and requires each one to be traceable. Three ways to
satisfy it:

**1. Quote a computed value.** Anything in the generated blocks is available, and so is a good deal
more: every cell and dimension score, every mean, median, count and gate tally, every number
appearing inside a tool-written string (audit findings, judge reasoning, grader diffs), every
context-to-context delta per task and per dimension, each cell's distance from 100, and
per-dimension counts of cells at and below 100 (so "17 of 20 cells scored 100 on imports" is fine).

**2. Put it in a code fence.** Quoted source, config or tool output is not a claim.

**3. Declare a `citedFigure`.** For anything you worked out by reading the system itself.

```yaml
citedFigures:
  - id: variant-prop-exports
    value: 10
    source: catalogs/my-system.json
    method: exports declaring a prop named variant
    derive: { kind: exportsWithProp, prop: variant }
```

`source` and `method` are the footnote a human analyst would write. `derive` is optional and better:
where it applies, `--validate` recomputes the value from the extracted catalog and fails on a
mismatch. A declared method is a promise; a derivation is a proof. Cite a figure from prose with
`{ kind: figure, figureId: variant-prop-exports }` on the finding.

The scanner ignores section cross-references, ISO dates, package versions, commit hashes, run ids,
inline code and link targets. If it flags a number you believe is right, the number is either wrong
or it is real analysis that belongs in `citedFigures`.

## Findings

### What must be written up

`--stats` prints a coverage list. Every item on it must be cited by at least one finding or
`--validate` fails. The list is generated from the data:

| Source | Rule |
|---|---|
| Gate | every cell that gated `fail` |
| Gate | every dimension that gated `review` on any cell |
| Audit | every check scoring below 70 |
| Audit | every check with a finding of severity `fail` |
| Audit | the vocabulary check, whenever it reports any divergence |
| Judge | every cell whose `judgment` score is below 60 |

You may add findings beyond this set. Give those an `obs-` id prefix.

Coverage forces you to address each item. It says nothing about what you conclude. "This is not a
defect, here is why" is a perfectly good finding.

### Ids are the history mechanism

A finding id names a **cause**, not a symptom, and it must stay stable across reports. If next
quarter's run surfaces the same underlying problem, it reuses the id. Coining a new id for a defect
that already has a name is what silently breaks the ability to see a system improve.

`--stats --since <previous report>` prints the previous report's ids for exactly this reason. When
a previous finding is resolved, carry it forward with `status: fixed` rather than dropping it: the
report is the record that it was fixed.

Prefer `button-role-prop` over `compile-error-in-cell-8`. The first still means something when the
cell numbering changes.

### Severity and owner

Judgement calls, not enforced. Use this table:

| `severity` | When |
|---|---|
| `defect` | The system's code is wrong or internally inconsistent. |
| `gap` | An asset that should exist does not. |
| `divergence` | A deliberate choice differing from ecosystem convention, with no failure attached. |
| `observation` | Everything else. Implies no action. |

| `owner` | When |
|---|---|
| `system` | The design system's problem. |
| `harness` | A benchmark defect that cost a cell. Section 7. |
| `tooling` | The build, the extractor, a dependency. |

`owner: harness` matters. A cell lost to a benchmark bug must never read as a defect in the design
system.

### Evidence

Every finding needs at least one, and every one is resolved against real data:

```yaml
evidence:
  - { kind: cell, runId: <id>, cellKey: <system>_<context>_<model>, taskId: <task>, rep: 1, dimension: compile }
  - { kind: auditCheck, checkId: surface }
  - { kind: file, path: packages/components/src/Button/Button.tsx, lines: "12-19" }
  - { kind: figure, figureId: variant-prop-exports }
```

A cited cell must exist in the run, a cited dimension must have a score on that cell, and a cited
check must be one the harness runs. Dangling citations fail validation.

## Sections 6 to 9

**6. Notable individual results.** Individual cells worth a reader's attention, most often one that
is mechanically perfect and substantively wrong. If nothing stands out, say so in a line.

**7. Harness defects.** Benchmark bugs hit while producing the report, with their impact and status.
"None" is a complete answer, but the section stays: a benchmark that never reports its own failures
is not reporting honestly.

**8. Validity limits.** What the report does not support. Single-rep runs cannot separate a
systematic effect from model variance. A run without a `bare` context cannot produce Lift, so its
composite is not comparable to one that has it. Say these plainly rather than letting a reader
over-read the numbers.

**9. Recommendations.** Grouped by cost and by whether they need a decision. Each links to the
findings it comes from via `findingIds`.

## Comparing reports over time

Two reports are numerically comparable only when their `comparabilityKey` matches. It encodes
profile, contexts, reps, consume mode, fixture and task count. A medium run with no `bare` context
cannot be read as a regression from a smoke run that had one, because Lift drops out of the
composite entirely.

Recommended layout, and worth committing so the history is in git:

```
docs/reports/
  my-system/
    2026-01-01-medium.report.md
    2026-04-01-full.report.md
```

## House style

Straight quotes, no em dashes, sentence-case headings. `--validate` warns on the first two. Lead
with what happened before the detail, say whose problem it is, and say whether anyone is blocked.
