---
name: ds-bench-report
description: Write an AI-readiness report from a completed open-design-system-bench run. Use when asked to write, author, draft or update a benchmark report, an AI-readiness report, or a design-system report from a run directory. Produces a markdown report validated against schema/report.schema.json.
---

# Writing an AI-readiness report

Read [`docs/report-authoring.md`](../../../docs/report-authoring.md) first. It is the contract, and
it is the source of truth for everything below. This file only sequences the work.

## The rule that governs everything

The data layer is fixed; the interpretation layer is free. Every number is machine-generated and
pasted verbatim. You never retype a figure and never do arithmetic. What you conclude from the
numbers is yours, and is expected to differ from what another author would write.

## Steps

**1. Compute.** Find the run directory (`runs/<run-id>/`), then:

```bash
npx tsx src/cli.ts report --stats --run runs/<run-id> --system <system-id> \
  --since reports/<system-id>/<most-recent>.report.md
```

Omit `--since` only when this is the system's first report. It carries finding ids forward, which is
the whole mechanism by which a defect stays trackable across reports.

**2. Investigate before writing.** For every cell in the coverage list that gated `fail`, read
`runs/<run-id>/cells/<cellKey>/<taskId>/rep<N>/diff.patch` and `grades.json`. Read `judge.json`
wherever judgment is low. Then read the relevant design-system source to find the actual cause.

A finding written from the leads list alone will name the symptom and miss the cause. The leads are
starting points, not conclusions. Note also that the leads deliberately do not tell you what to
conclude: deciding an item is not a real defect is a legitimate finding, provided you say so.

**3. Write** `reports/<system-id>/<YYYY-MM-DD>-<profile>.report.md`.

- Front matter: paste the computed block from `--stats`, then add `reportId`, `generatedAt`,
  `title`, `author`, `subject`, `harness`, `methodology.deviations`, `citedFigures`, `findings`,
  `recommendations` and `validityLimits`.
- Body: use the exact heading list in the authoring doc, in order. Paste generated sections
  verbatim. Write sections 2, 2.4, 4, 5, 6, 7, 8 and 9.
- Every item on the coverage list needs a finding citing it.
- Reuse a finding id from `--since` whenever the underlying cause is the same. Carry a resolved one
  forward with `status: fixed` rather than deleting it.
- Any number you worked out yourself goes in `citedFigures` with its source and method, and a
  `derive` recipe where one applies.

**4. Validate, and loop until clean.**

```bash
npx tsx src/cli.ts report --validate reports/<system-id>/<date>-<profile>.report.md
```

Exit 0 means done. Fix what it names and run it again.

## When a gate fires

- **G3 generated** - you edited a computed block. Re-run `--stats` and paste it again. Do not hand-edit.
- **G4 numbers** - a figure in your prose is not traceable. Either it is wrong, or it is real
  analysis that needs a `citedFigures` entry naming its source and method.
- **G9 evidence** - a citation does not resolve against the run. Check the cellKey, taskId, rep and
  dimension against `results.json`.
- **G10 coverage** - something on the coverage list has no finding. Address it; you may conclude it
  is not a problem, but you may not omit it.
- **G14 style** - straight quotes, no em dashes.

## Do not

- Do not run `run`, `grade` or `judge`. They cost real money and the operator has to ask for them.
  Reporting is free and reads existing artifacts only.
- Do not write to the design system's repository. Read from it only.
- Do not soften a hard failure. Two failing cells out of twenty is the finding, not a rounding error.
