// Affordances a task rubric can presume (TaskRubric.presumes). A rubric such
// as "builds the field on the system's input component" can only be graded on
// a system that has one. When the catalog exports none of an affordance's
// names, the rubric is withheld for that system and its weight redistributed,
// the same null-over-a-guess rule the audit follows: a judge asked to grade
// against a component that does not exist fills the gap by inventing it.
//
// Defaults are conventional export names, matched exactly against
// catalog.allExports. SystemConfig.affordances extends them per system.

import type { SystemCatalog, SystemConfig, Task } from '../types.ts';

export const DEFAULT_AFFORDANCES: Record<string, string[]> = {
  'text-input': ['Input', 'TextInput', 'TextField', 'PasswordInput', 'PasswordField', 'InputField', 'TextBox'],
};

/** Export names that provide `affordance` for a system: the defaults plus the system's own. */
export function affordanceNames(affordance: string, cfg?: Pick<SystemConfig, 'affordances'>): string[] {
  return [...(DEFAULT_AFFORDANCES[affordance] ?? []), ...(cfg?.affordances?.[affordance] ?? [])];
}

/** rubricId -> why it cannot be graded on this system. Empty when every rubric is gradeable. */
export function withheldRubrics(
  task: Task,
  catalog: Pick<SystemCatalog, 'system' | 'allExports'>,
  cfg?: Pick<SystemConfig, 'affordances'>,
): Map<string, string> {
  const exports = new Set(catalog.allExports);
  const out = new Map<string, string>();
  for (const r of task.rubrics) {
    if (!r.presumes) continue;
    const names = affordanceNames(r.presumes, cfg);
    if (names.some((n) => exports.has(n))) continue;
    out.set(
      r.id,
      `presumes a ${r.presumes} affordance, and the ${catalog.system} catalog exports none of ${names.join(', ') || '(no names declared)'}`,
    );
  }
  return out;
}
