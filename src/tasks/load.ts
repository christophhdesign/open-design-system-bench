// Loads the task suite from tasks/*.yaml and validates cross-task invariants
// that a single-file schema check can't see (duplicate ids, weight sums, and —
// given extracted system catalogs — prompt-leak and hidden-expectation checks).

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.ts';
import type { SystemCatalog, SystemId, Task } from '../types.ts';
import { parseTask } from './schema.ts';

/**
 * Symbols that are skipped by the prompt-leak lint even when they match a real
 * catalog export, because they double as ordinary English words that intent-
 * level prompts can't reasonably avoid. Keep this short — every addition
 * weakens the leak check system-wide, not just for the prompt that needed it.
 *
 * - Text, Link, Card, Icon: generic UI nouns, near-impossible to avoid entirely
 *   across a growing task suite.
 * - Form: "invite a team member form" (form-validation-errors) uses "form" as
 *   the ordinary English noun for the whole submission, not a reference to a
 *   system's `Form` wrapper component.
 * - List: "the server list" (connection-status-indicator) uses "list" as the
 *   ordinary English noun for a collection, not a reference to a system's
 *   `List` component.
 */
export const GENERIC_SYMBOL_ALLOWLIST = ['Text', 'Link', 'Card', 'Icon', 'Form', 'List'] as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `task` applies to `system` — absent `systems`, or a ['*'] wildcard, means every configured system. */
export function taskAppliesToSystem(task: Task, system: SystemId): boolean {
  if (!task.systems || task.systems.includes('*')) return true;
  return task.systems.includes(system);
}

export function loadTasks(tasksDir: string = paths.tasksDir): Task[] {
  const files = readdirSync(tasksDir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  return files.map((file) => {
    const yamlText = readFileSync(join(tasksDir, file), 'utf8');
    return parseTask(yamlText, file);
  });
}

export function validateTaskSuite(
  tasks: Task[],
  catalogs: Partial<Record<SystemId, SystemCatalog>>,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const allowlist = new Set<string>(GENERIC_SYMBOL_ALLOWLIST.map((w) => w.toLowerCase()));

  // (b) duplicate task ids -----------------------------------------------------
  const idCounts = new Map<string, number>();
  for (const task of tasks) {
    idCounts.set(task.id, (idCounts.get(task.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      errors.push(`duplicate task id "${id}" (appears ${count} times)`);
    }
  }

  for (const task of tasks) {
    // (a) rubric weights sum to 1 ± 0.001 ---------------------------------------
    const weightSum = task.rubrics.reduce((sum, r) => sum + r.weight, 0);
    if (Math.abs(weightSum - 1) > 0.001) {
      errors.push(
        `task "${task.id}": rubric weights sum to ${weightSum.toFixed(4)}, expected 1 ± 0.001`,
      );
    }

    // (e) critical rubrics: warn if a task has none -----------------------------
    if (!task.rubrics.some((r) => r.critical)) {
      warnings.push(`task "${task.id}": no rubric is marked critical`);
    }

    // (g) hiddenExpectations optional: warn (never error) when absent -----------
    if (!task.hiddenExpectations) {
      warnings.push(
        `task "${task.id}": no hiddenExpectations — the judge will omit the expected-components catalog excerpt for this task`,
      );
    }

    // Systems this task actually applies to, restricted to the catalogs we
    // were handed (an explicit "systems" list may still name a system whose
    // catalog isn't extracted/loaded yet — that's warned on below, not here).
    const explicitSystems = task.systems && !task.systems.includes('*') ? task.systems : undefined;
    const systemsInScope = explicitSystems ?? (Object.keys(catalogs) as SystemId[]);

    for (const system of systemsInScope) {
      const catalog = catalogs[system];

      // (f) missing catalog for an applicable system ---------------------------------
      if (!catalog) {
        warnings.push(
          `task "${task.id}": catalog not extracted yet, leak/expectation checks skipped for ${system}`,
        );
        continue;
      }

      // (c) prompt-leak lint: any real export named in the prompt is a leak ------
      for (const symbol of catalog.allExports) {
        if (allowlist.has(symbol.toLowerCase())) continue;
        const wholeWord = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'i');
        if (wholeWord.test(task.prompt)) {
          errors.push(
            `task "${task.id}": prompt leaks ${system} component "${symbol}" (case-insensitive whole-word match in prompt text)`,
          );
        }
      }

      // (d) hiddenExpectations.componentsAnyOf symbols must be real exports -------
      const expected = task.hiddenExpectations?.componentsAnyOf[system];
      if (expected) {
        const exportSet = new Set(catalog.allExports);
        for (const symbol of expected) {
          if (!exportSet.has(symbol)) {
            errors.push(
              `task "${task.id}": hiddenExpectations.componentsAnyOf.${system} references "${symbol}", which is not in the ${system} catalog's allExports`,
            );
          }
        }
      }
    }
  }

  return { errors, warnings };
}
