# Reports

`report.html` is a heatmap for reading a single run. A **written report** is the other artifact: the
document you hand to a design-system team, and the record you compare against next quarter.

## What is in this folder

| Path | What | Tracked |
|---|---|---|
| `report-authoring.md` | The contract. What a report must contain, what evidence each finding needs, how the gates work. Tool-agnostic. | yes |
| `report-example.md` | A complete worked example on a synthetic system. Generated from a committed fixture, so it cannot drift. | yes |
| `<system-id>/` | Your generated reports, one directory per design system. | **no, gitignored** |

Generated reports are output about *your* design system, not about this tool, so they stay local for
the same reason `runs/` does. Nothing stops you committing them: un-ignore the path in your own fork,
or keep them in whatever repository already holds your design-system work. `--since` takes a path, so
history works wherever you put them.

## The workflow

```bash
# 1. Compute every number the report needs. --since carries finding ids forward
#    from the previous report, which is what makes history work.
npx tsx src/cli.ts report --stats --run runs/<run-id> --system <system-id> \
  --since docs/reports/<system-id>/<previous>.report.md

# 2. Write docs/reports/<system-id>/<YYYY-MM-DD>-<profile>.report.md

# 3. Check it. Loop until it exits 0.
npx tsx src/cli.ts report --validate docs/reports/<system-id>/<date>-<profile>.report.md
```

Reports are agent-authored. In Claude Code, `.claude/skills/ds-bench-report/` drives it. With any
other agent, point it at `report-authoring.md`.

## Why it is built this way

**The data layer is fixed. The interpretation layer is free.**

`report --stats` computes every number and emits the front matter plus the generated sections as
finished markdown. The author pastes them verbatim and never does arithmetic. `report --validate`
re-renders those blocks and fails on a byte difference, then requires every number in the prose to
resolve to a computed value, to a declared `citedFigures` entry, or to a code fence.

Findings, notable results, validity limits and recommendations are the author's, and two authors
will write them differently, the way two human analysts would. The gates enforce **coverage** (every
hard failure and every low audit score must be addressed) and **grounding** (every citation must
resolve against the real run). They never dictate a conclusion. "This is not a defect, and here is
why" passes.

The reason for the split: an agent can be wrong about what a number *means*, which is interpretation
and is expected. It must not be wrong about what the number *is*.

## The file format

The artifact is markdown. Its YAML front matter conforms to
[`../../schema/report.schema.json`](../../schema/report.schema.json), which is what makes a folder of
reports machine-comparable over time. The front matter is an index: identity, headline numbers, and a
structured list of findings. The prose body below carries the writing.

Two things in it exist purely for history:

- **`comparabilityKey`** encodes profile, contexts, reps, consume mode and fixture. Two reports are
  numerically comparable only when it matches, because a composite computed over a different axis set
  is a different measurement.
- **Finding ids** name a cause and stay stable across reports. If next quarter surfaces the same
  underlying problem, it reuses the id, and a resolved one is carried forward as `fixed` rather than
  deleted. Coining a new id for a defect that already has a name is what silently breaks the ability
  to see a system improve.

`report-authoring.md` is the full contract. Read it before writing one.
