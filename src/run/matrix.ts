import type { BenchConfig, BenchProfile, CellSpec, ContextLevel, SystemId, Task } from '../types.ts';
import { parseModelSpec } from '../providers/model-spec.ts';
import { taskAppliesToSystem } from '../tasks/load.ts';

export interface MatrixFilters {
  systems?: SystemId[];
  contexts?: ContextLevel[];
  models?: string[];
  tasks?: string[];
  reps?: number;
}

export interface ExpandedMatrix {
  cells: CellSpec[];
  skipped: Array<{ spec: CellSpec; reason: string }>;
}

/** Expand a profile (optionally narrowed by CLI filters) into concrete cells. */
export function expandMatrix(
  profile: BenchProfile,
  bench: BenchConfig,
  tasks: Task[],
  filters: MatrixFilters = {},
): ExpandedMatrix {
  const systems = filters.systems ?? profile.systems;
  const contexts = filters.contexts ?? profile.contexts;
  const models = filters.models ?? profile.models;
  const reps = filters.reps ?? profile.reps;

  const taskIds =
    filters.tasks ?? (profile.tasks === '*' ? tasks.map((t) => t.id) : profile.tasks);
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const cells: CellSpec[] = [];
  const skipped: ExpandedMatrix['skipped'] = [];

  for (const system of systems) {
    for (const context of contexts) {
      for (const model of models) {
        // A qualified model string ("openai:gpt-5.2") routes generation through
        // the single-shot api-oneshot adapter for that provider; a plain model
        // name ("sonnet") keeps using the configured default (claude-code).
        const { provider } = parseModelSpec(model, bench);
        const agent = provider ? 'api-oneshot' : bench.defaults.agent;
        for (const taskId of taskIds) {
          for (let rep = 1; rep <= reps; rep++) {
            const spec: CellSpec = { system, context, model, agent, taskId, rep };
            const task = taskById.get(taskId);
            if (!task) {
              skipped.push({ spec, reason: `unknown task id "${taskId}"` });
            } else if (context === 'mcp') {
              skipped.push({ spec, reason: 'mcp context is deferred to the next phase' });
            } else if (!taskAppliesToSystem(task, system)) {
              skipped.push({ spec, reason: `task not applicable to system "${system}"` });
            } else {
              cells.push(spec);
            }
          }
        }
      }
    }
  }
  return { cells, skipped };
}
