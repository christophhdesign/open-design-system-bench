# Fixtures

A fixture is the disposable app the benchmark puts the agent inside. It is a small React project
that already knows how to import one design system, with a single blank file for the agent to fill
in:

```tsx
// src/task/index.tsx, as shipped
export function TaskScreen() {
  // Implement the task here.
  return null;
}
```

The agent receives an intent-level task prompt, writes that file, and the harness diffs it against
the blank version. Every graded dimension reads that diff. Nothing else in the workspace is the
agent's work, which is why the fixture has to be set up correctly before a run means anything: you
are measuring the agent's use of the design system, not its ability to configure a build.

Each cell gets its own throwaway copy. `node_modules` is symlinked in from the template rather than
reinstalled, and `prune` deletes the copies when you are done. This directory holds the moulds, not
the castings.

## What ships, and what stays local

| Template | Consume mode | Shipped |
|---|---|---|
| `source-app` | `source` - aliases the fixture straight at the system's source directory, no build step | yes |
| `npm-app` | `npm` - installs the published package into a prepared workspace | yes |
| anything else | either | **no, gitignored** |

A template written for a specific design system encodes that system's repository layout: where its
components live, which React version it pins, whether it uses Tailwind, which ambient declarations
its source needs. That is a description of a private repo, and it is useless to anyone else. So
`.gitignore` keeps the two generic templates and ignores every other directory here.

If you need your own, copy the generic one and keep it local:

```bash
cp -r fixtures/source-app fixtures/<your-system>-app
```

Then point at it from your system's entry in `systems.config.json`:

```json
"fixtureTemplate": "fixtures/<your-system>-app"
```

## Placeholders

At provision time the harness substitutes three placeholders across `vite.config.ts`,
`tsconfig.json`, `index.html`, `src/App.tsx` and `src/main.tsx`:

| Placeholder | Filled with |
|---|---|
| `__SYSTEM_ROOT__` | absolute path to the design system checkout, forward slashes on every platform |
| `__COMPONENTS_PKG__` | `componentsPkg` from the system config |
| `__FOUNDATIONS_PKG__` | `foundationsPkg` from the system config |

## Docs and skills at the guided context levels

`agentContext.extraDocs` and `agentContext.skillDirs` are injected at the `skill` context level.
Two things about them are easy to get wrong:

**A skill has to land where an agent looks for it**, which is
`.claude/skills/<name>/SKILL.md`. `skillDirs` accepts either a single skill bundle or a directory
containing several, and the harness tells them apart by looking for a `SKILL.md`. A path naming a
directory *of* bundles used to be copied wholesale, putting every skill one level too deep and
making all of them invisible.

**`extraDocs` accepts globs**, and an entry containing `*` behaves differently from a literal path:

| Entry | Lands at |
|---|---|
| `pkg/COMPONENTS.md` | `docs/COMPONENTS.md`, flattened to its basename |
| `pkg/src/**/readme.md` | `docs/pkg/src/**/readme.md`, tree preserved |

Globs preserve structure because flattening cannot work for them: a hundred files all named
`readme.md` would overwrite each other down to one, and an index that links to its siblings by
relative path only resolves if the tree is intact. Reach for a glob when the documentation worth
giving the agent is scattered through the source tree rather than gathered in a docs directory -
per-component API tables are the common case, and naming the parent directory instead would copy
the entire implementation alongside them.

Note what is **not** substituted: where the components sit *inside* the checkout. `source-app`
hardcodes a `packages/components/src` layout in its tsconfig paths and Vite aliases. A system that
keeps components anywhere else needs its own template, even when nothing else about it is unusual.
That is the most common reason to end up with a local fixture.

## Getting a local template right

Three things reliably need attention, all of them the difference between measuring a design system
and measuring your own fixture:

**Point the aliases at the real layout.** Both `vite.config.ts` and `tsconfig.json` carry the path,
and they must agree. Vite resolves what runs; tsc resolves what the `compile` dimension grades.

**Match the React major.** Consuming from source means the fixture and the system share one React
instance. A version mismatch surfaces as "two different types with this name exist, but they are
unrelated", which fails the compile gate on code that is perfectly correct.

**Include the system's ambient declarations.** If component sources import `.css` siblings or
augment a global type, those declarations have to be in the fixture's tsconfig `include`. Without
them, source files that typecheck cleanly in their own repository fail the compile gate here.

Only remove something from the template when the system genuinely does not offer it. Dropping
Tailwind from a fixture for a system whose consumers do not use Tailwind is correct: leaving it in
hands the agent a styling escape hatch that production does not have, which flatters
`tokenDiscipline`. Dropping it from a system that does use it would invalidate the run.

Record every deviation in your report's methodology section. Scores from a modified template are not
strictly comparable against a system benchmarked on the stock one, and the report should say so.
