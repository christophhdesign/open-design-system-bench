// A dependency-free validator for the subset of JSON Schema draft 2020-12 that
// schema/report.schema.json uses. Exists so the schema file stays the single
// source of truth: the validator interprets it rather than restating its rules
// in TypeScript, which is the drift the judge's inline JUDGE_OUTPUT_SCHEMA and
// its "keep in sync" comment already invite.
//
// Supported: $ref (local, "#/$defs/Name"), $defs, type (string or string[]),
// enum, const, properties, required, additionalProperties (false or a schema),
// patternProperties, items, minItems, minLength, pattern, minimum, maximum,
// oneOf. Everything else is ignored, so a schema may carry description/title/
// examples freely for human readers.
//
// Adding a keyword to schema/report.schema.json that is not on that list is a
// silent no-op rather than an error. json-schema-lite.test.ts exists to catch
// that, and any new keyword needs a case there.

export interface SchemaError {
  /** Dotted/bracketed path into the validated value, e.g. `findings[0].severity`. */
  path: string;
  message: string;
}

export type JsonSchema = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON Schema's type vocabulary, with `integer` distinguished from `number`. */
function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(actual: string, expected: string): boolean {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function joinPath(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

/** Resolves a local "#/$defs/Name" pointer against the root schema. */
function resolveRef(ref: string, root: JsonSchema): JsonSchema | null {
  if (!ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(node)) return null;
    node = node[seg];
  }
  return isPlainObject(node) ? node : null;
}

function deref(schema: JsonSchema, root: JsonSchema): JsonSchema {
  let current = schema;
  // Bounded: a longer $ref chain is a malformed schema, not malformed input.
  for (let hops = 0; hops < 16; hops += 1) {
    const ref = current.$ref;
    if (typeof ref !== 'string') return current;
    const resolved = resolveRef(ref, root);
    if (!resolved) return current;
    current = resolved;
  }
  return current;
}

/**
 * For a tagged union, picks the branch whose `properties.<tag>.const` matches
 * the value's tag. Without this, a malformed `evidence` entry reports only
 * "matches none of the 4 allowed shapes", which tells an author nothing. With
 * it, the errors come from the branch they actually meant.
 */
function discriminate(
  value: Record<string, unknown>,
  branches: JsonSchema[],
  root: JsonSchema,
): JsonSchema | null {
  for (const tag of ['kind', 'type']) {
    const tagValue = value[tag];
    if (typeof tagValue !== 'string') continue;
    for (const raw of branches) {
      const branch = deref(raw, root);
      const props = branch.properties;
      if (!isPlainObject(props)) continue;
      const tagSchema = props[tag];
      if (isPlainObject(tagSchema) && tagSchema.const === tagValue) return branch;
    }
  }
  return null;
}

function validateNode(
  value: unknown,
  rawSchema: JsonSchema,
  path: string,
  root: JsonSchema,
  errors: SchemaError[],
): void {
  const schema = deref(rawSchema, root);
  const here = path || '<root>';

  // --- oneOf -------------------------------------------------------------
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf) && oneOf.length > 0) {
    const branches = oneOf.filter(isPlainObject);
    if (isPlainObject(value)) {
      const picked = discriminate(value, branches, root);
      if (picked) {
        validateNode(value, picked, path, root, errors);
        return;
      }
    }
    const matched = branches.some((b) => collect(value, b, path, root).length === 0);
    if (!matched) {
      errors.push({ path: here, message: `matches none of the ${branches.length} allowed shapes` });
    }
    return;
  }

  // --- type --------------------------------------------------------------
  const expectedType = schema.type;
  const actual = typeOf(value);
  if (typeof expectedType === 'string') {
    if (!typeMatches(actual, expectedType)) {
      errors.push({ path: here, message: `must be ${expectedType}, got ${actual}` });
      return;
    }
  } else if (Array.isArray(expectedType)) {
    const allowed = expectedType.filter((t): t is string => typeof t === 'string');
    if (!allowed.some((t) => typeMatches(actual, t))) {
      errors.push({ path: here, message: `must be ${allowed.join(' or ')}, got ${actual}` });
      return;
    }
  }

  // --- const / enum ------------------------------------------------------
  if ('const' in schema && value !== schema.const) {
    errors.push({ path: here, message: `must be ${JSON.stringify(schema.const)}` });
    return;
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((e) => e === value)) {
    errors.push({ path: here, message: `must be one of: ${enumValues.map(String).join(', ')}` });
    return;
  }

  // --- string ------------------------------------------------------------
  if (typeof value === 'string') {
    const minLength = schema.minLength;
    if (typeof minLength === 'number' && value.length < minLength) {
      errors.push({
        path: here,
        message: minLength === 1 ? 'must not be empty' : `must be at least ${minLength} characters`,
      });
    }
    const pattern = schema.pattern;
    if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) {
      errors.push({ path: here, message: `must match ${pattern}` });
    }
  }

  // --- number ------------------------------------------------------------
  if (typeof value === 'number') {
    const min = schema.minimum;
    if (typeof min === 'number' && value < min) errors.push({ path: here, message: `must be >= ${min}` });
    const max = schema.maximum;
    if (typeof max === 'number' && value > max) errors.push({ path: here, message: `must be <= ${max}` });
  }

  // --- array -------------------------------------------------------------
  if (Array.isArray(value)) {
    const minItems = schema.minItems;
    if (typeof minItems === 'number' && value.length < minItems) {
      errors.push({ path: here, message: `must have at least ${minItems} item${minItems === 1 ? '' : 's'}` });
    }
    const items = schema.items;
    if (isPlainObject(items)) {
      value.forEach((item, i) => validateNode(item, items, `${path}[${i}]`, root, errors));
    }
    return;
  }

  // --- object ------------------------------------------------------------
  if (isPlainObject(value)) {
    const required = schema.required;
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && value[key] === undefined) {
          errors.push({ path: joinPath(path, key), message: 'is required' });
        }
      }
    }

    const props = isPlainObject(schema.properties) ? schema.properties : {};
    const patternProps = isPlainObject(schema.patternProperties) ? schema.patternProperties : {};
    const additional = schema.additionalProperties;

    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      const childPath = joinPath(path, key);

      const propSchema = props[key];
      if (isPlainObject(propSchema)) {
        validateNode(child, propSchema, childPath, root, errors);
        continue;
      }

      let handled = false;
      for (const [pattern, patternSchema] of Object.entries(patternProps)) {
        if (isPlainObject(patternSchema) && new RegExp(pattern).test(key)) {
          validateNode(child, patternSchema, childPath, root, errors);
          handled = true;
          break;
        }
      }
      if (handled) continue;

      if (additional === false) {
        errors.push({ path: childPath, message: 'is not an allowed property' });
      } else if (isPlainObject(additional)) {
        validateNode(child, additional, childPath, root, errors);
      }
    }
  }
}

function collect(value: unknown, schema: JsonSchema, path: string, root: JsonSchema): SchemaError[] {
  const errors: SchemaError[] = [];
  validateNode(value, schema, path, root, errors);
  return errors;
}

/**
 * Validates `data` against `schema`. Returns every error found rather than
 * throwing on the first, so an authoring agent can fix a document in one pass
 * instead of one error per run.
 */
export function validateAgainstSchema(data: unknown, schema: JsonSchema): SchemaError[] {
  return collect(data, schema, '', schema);
}

/** `findings[0].severity: must be one of: defect, gap, ...` */
export function formatSchemaErrors(errors: SchemaError[]): string[] {
  return errors.map((e) => `${e.path || '<root>'}: ${e.message}`);
}
