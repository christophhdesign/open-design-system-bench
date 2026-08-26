// YAML -> Task parsing with strict shape validation. Throws descriptive errors
// (prefixed with the offending file) rather than returning partial/invalid Tasks.
//
// `systems` is intentionally NOT validated against a fixed enum here — SystemId
// is an open string set (whatever a systems.config.json declares), so a task
// file can't know in advance which ids are "valid". Cross-checking task
// systems/hiddenExpectations against what's actually configured happens in
// validateTaskSuite, which has the loaded catalogs to check against.

import { load } from 'js-yaml';
import type { SystemId, Task, TaskRubric } from '../types.ts';

function fail(filename: string, message: string): never {
  throw new Error(`[tasks/${filename}] ${message}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function expectObject(v: unknown, filename: string, path: string): Record<string, unknown> {
  if (!isPlainObject(v)) {
    fail(filename, `"${path}" must be an object`);
  }
  return v;
}

function expectNonEmptyString(v: unknown, filename: string, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    fail(filename, `"${path}" must be a non-empty string`);
  }
  return v;
}

function expectStringArray(v: unknown, filename: string, path: string): string[] {
  if (!Array.isArray(v)) {
    fail(filename, `"${path}" must be an array`);
  }
  return v.map((item, i) => expectNonEmptyString(item, filename, `${path}[${i}]`));
}

/**
 * Parse and strictly validate a single task YAML document.
 * @param yamlText raw YAML source
 * @param filename the task's filename (with extension, e.g. "confirm-account-deletion.yaml") —
 *   used both for error messages and to check that `id` matches the filename stem.
 */
export function parseTask(yamlText: string, filename: string): Task {
  let raw: unknown;
  try {
    raw = load(yamlText);
  } catch (err) {
    fail(filename, `invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const root = expectObject(raw, filename, '<root>');
  const stem = filename.replace(/\.ya?ml$/i, '');

  // --- id ---------------------------------------------------------------
  const id = expectNonEmptyString(root.id, filename, 'id');
  if (id !== stem) {
    fail(filename, `"id" ("${id}") must match the filename stem ("${stem}")`);
  }

  // --- title --------------------------------------------------------------
  const title = expectNonEmptyString(root.title, filename, 'title');

  // --- systems (optional; absent or ['*'] = applies to every configured system) --
  let systems: SystemId[] | undefined;
  if (root.systems !== undefined) {
    const arr = expectStringArray(root.systems, filename, 'systems');
    if (arr.length === 0) {
      fail(filename, '"systems" must not be an empty array — omit the field instead to apply to every system');
    }
    if (new Set(arr).size !== arr.length) {
      fail(filename, '"systems" contains duplicate entries');
    }
    systems = arr;
  }
  const isWildcard = (s: SystemId[] | undefined): boolean => !!s && (s.length === 1 ? s[0] === '*' : s.includes('*'));

  // --- prompt ---------------------------------------------------------------
  const prompt = expectNonEmptyString(root.prompt, filename, 'prompt');

  // --- hiddenExpectations (optional) -----------------------------------------
  let hiddenExpectations: Task['hiddenExpectations'];
  if (root.hiddenExpectations !== undefined) {
    const he = expectObject(root.hiddenExpectations, filename, 'hiddenExpectations');
    const componentsAnyOfRaw = expectObject(
      he.componentsAnyOf,
      filename,
      'hiddenExpectations.componentsAnyOf',
    );
    const componentsAnyOf: Partial<Record<SystemId, string[]>> = {};
    for (const [key, value] of Object.entries(componentsAnyOfRaw)) {
      if (systems && !isWildcard(systems) && !systems.includes(key)) {
        fail(
          filename,
          `"hiddenExpectations.componentsAnyOf.${key}" is set but "${key}" is not in this task's "systems"`,
        );
      }
      const symbols = expectStringArray(value, filename, `hiddenExpectations.componentsAnyOf.${key}`);
      if (symbols.length === 0) {
        fail(filename, `"hiddenExpectations.componentsAnyOf.${key}" must not be an empty array`);
      }
      componentsAnyOf[key] = symbols;
    }

    let notes: string | undefined;
    if (he.notes !== undefined) {
      notes = expectNonEmptyString(he.notes, filename, 'hiddenExpectations.notes');
    }
    hiddenExpectations = notes !== undefined ? { componentsAnyOf, notes } : { componentsAnyOf };
  }

  // --- rubrics --------------------------------------------------------------
  if (!Array.isArray(root.rubrics) || root.rubrics.length === 0) {
    fail(filename, '"rubrics" must be a non-empty array');
  }
  const seenRubricIds = new Set<string>();
  const rubrics: TaskRubric[] = root.rubrics.map((entry, i) => {
    const r = expectObject(entry, filename, `rubrics[${i}]`);
    const rid = expectNonEmptyString(r.id, filename, `rubrics[${i}].id`);
    if (seenRubricIds.has(rid)) {
      fail(filename, `"rubrics" contains duplicate id "${rid}"`);
    }
    seenRubricIds.add(rid);
    const text = expectNonEmptyString(r.text, filename, `rubrics[${i}] ("${rid}").text`);
    if (typeof r.weight !== 'number' || !Number.isFinite(r.weight)) {
      fail(filename, `rubrics[${i}] ("${rid}").weight must be a number`);
    }
    if (r.weight <= 0 || r.weight > 1) {
      fail(filename, `rubrics[${i}] ("${rid}").weight must be in (0, 1]`);
    }
    const rubric: TaskRubric = { id: rid, text, weight: r.weight };
    if (r.critical !== undefined) {
      if (typeof r.critical !== 'boolean') {
        fail(filename, `rubrics[${i}] ("${rid}").critical must be a boolean when present`);
      }
      rubric.critical = r.critical;
    }
    return rubric;
  });

  // --- mechanicalOverrides (optional) ----------------------------------------
  let mechanicalOverrides: Task['mechanicalOverrides'];
  if (root.mechanicalOverrides !== undefined) {
    const mo = expectObject(root.mechanicalOverrides, filename, 'mechanicalOverrides');
    mechanicalOverrides = {};
    if (mo.allowHexIn !== undefined) {
      mechanicalOverrides.allowHexIn = expectStringArray(
        mo.allowHexIn,
        filename,
        'mechanicalOverrides.allowHexIn',
      );
    }
    if (mo.extraAllowedImports !== undefined) {
      mechanicalOverrides.extraAllowedImports = expectStringArray(
        mo.extraAllowedImports,
        filename,
        'mechanicalOverrides.extraAllowedImports',
      );
    }
  }

  // --- timeoutSec (optional) --------------------------------------------------
  let timeoutSec: number | undefined;
  if (root.timeoutSec !== undefined) {
    if (typeof root.timeoutSec !== 'number' || !Number.isFinite(root.timeoutSec) || root.timeoutSec <= 0) {
      fail(filename, '"timeoutSec" must be a positive number when present');
    }
    timeoutSec = root.timeoutSec;
  }

  const task: Task = {
    id,
    title,
    prompt,
    rubrics,
  };
  if (systems !== undefined) task.systems = systems;
  if (hiddenExpectations !== undefined) task.hiddenExpectations = hiddenExpectations;
  if (mechanicalOverrides !== undefined) task.mechanicalOverrides = mechanicalOverrides;
  if (timeoutSec !== undefined) task.timeoutSec = timeoutSec;

  return task;
}
