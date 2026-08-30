// One case per supported keyword. A keyword that appears in
// schema/report.schema.json but has no case here is a silent no-op, so adding a
// keyword to the schema means adding a case here too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSchemaErrors, validateAgainstSchema, type JsonSchema } from './json-schema-lite.ts';

function errs(data: unknown, schema: JsonSchema): string[] {
  return formatSchemaErrors(validateAgainstSchema(data, schema));
}

test('type: primitives, with integer distinguished from number', () => {
  assert.deepEqual(errs('x', { type: 'string' }), []);
  assert.deepEqual(errs(1.5, { type: 'number' }), []);
  assert.deepEqual(errs(2, { type: 'number' }), []);
  assert.deepEqual(errs(2, { type: 'integer' }), []);
  assert.deepEqual(errs(1.5, { type: 'integer' }), ['<root>: must be integer, got number']);
  assert.deepEqual(errs(null, { type: 'string' }), ['<root>: must be string, got null']);
  assert.deepEqual(errs([], { type: 'object' }), ['<root>: must be object, got array']);
});

test('type: a union permits null', () => {
  const schema = { type: ['string', 'null'] };
  assert.deepEqual(errs('x', schema), []);
  assert.deepEqual(errs(null, schema), []);
  assert.deepEqual(errs(3, schema), ['<root>: must be string or null, got integer']);
});

test('required reports each missing key at its own path', () => {
  const schema = { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } };
  assert.deepEqual(errs({ a: 'x' }, schema), ['b: is required']);
  assert.deepEqual(errs({}, schema), ['a: is required', 'b: is required']);
});

test('additionalProperties: false rejects unknown keys', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } };
  assert.deepEqual(errs({ a: 'x' }, schema), []);
  assert.deepEqual(errs({ a: 'x', b: 1 }, schema), ['b: is not an allowed property']);
});

test('additionalProperties: a schema types an open map', () => {
  const schema = { type: 'object', additionalProperties: { type: 'number' } };
  assert.deepEqual(errs({ imports: 100, judgment: 82.5 }, schema), []);
  assert.deepEqual(errs({ imports: 'high' }, schema), ['imports: must be number, got string']);
});

test('patternProperties matches by key', () => {
  const schema = { type: 'object', patternProperties: { '^x-': { type: 'boolean' } }, additionalProperties: false };
  assert.deepEqual(errs({ 'x-flag': true }, schema), []);
  assert.deepEqual(errs({ 'x-flag': 1 }, schema), ['x-flag: must be boolean, got integer']);
  assert.deepEqual(errs({ other: true }, schema), ['other: is not an allowed property']);
});

test('items validates every element and paths use brackets', () => {
  const schema = { type: 'array', items: { type: 'integer' } };
  assert.deepEqual(errs([1, 2], schema), []);
  assert.deepEqual(errs([1, 'two', 3.5], schema), ['[1]: must be integer, got string', '[2]: must be integer, got number']);
});

test('minItems', () => {
  assert.deepEqual(errs([], { type: 'array', minItems: 1 }), ['<root>: must have at least 1 item']);
  assert.deepEqual(errs([1], { type: 'array', minItems: 1 }), []);
  assert.deepEqual(errs([1], { type: 'array', minItems: 2 }), ['<root>: must have at least 2 items']);
});

test('enum and const', () => {
  assert.deepEqual(errs('pass', { enum: ['pass', 'review', 'fail'] }), []);
  assert.deepEqual(errs('maybe', { enum: ['pass', 'review', 'fail'] }), ['<root>: must be one of: pass, review, fail']);
  assert.deepEqual(errs(1, { const: 1 }), []);
  assert.deepEqual(errs(2, { const: 1 }), ['<root>: must be 1']);
});

test('minLength and pattern', () => {
  assert.deepEqual(errs('', { type: 'string', minLength: 1 }), ['<root>: must not be empty']);
  assert.deepEqual(errs('ab', { type: 'string', minLength: 3 }), ['<root>: must be at least 3 characters']);
  assert.deepEqual(errs('Not-Kebab', { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' }), [
    '<root>: must match ^[a-z0-9][a-z0-9-]*$',
  ]);
  assert.deepEqual(errs('kebab-case', { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' }), []);
});

test('minimum and maximum', () => {
  const schema = { type: 'number', minimum: 0, maximum: 100 };
  assert.deepEqual(errs(50, schema), []);
  assert.deepEqual(errs(-1, schema), ['<root>: must be >= 0']);
  assert.deepEqual(errs(101, schema), ['<root>: must be <= 100']);
});

test('$ref resolves against $defs', () => {
  const schema: JsonSchema = {
    type: 'object',
    properties: { score: { $ref: '#/$defs/score' } },
    $defs: { score: { type: 'number', minimum: 0, maximum: 100 } },
  };
  assert.deepEqual(errs({ score: 90 }, schema), []);
  assert.deepEqual(errs({ score: 200 }, schema), ['score: must be <= 100']);
});

test('oneOf reports the branch the author meant, using the kind discriminator', () => {
  const schema: JsonSchema = {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'cellKey'],
        properties: { kind: { const: 'cell' }, cellKey: { type: 'string' } },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'checkId'],
        properties: { kind: { const: 'auditCheck' }, checkId: { type: 'string' } },
      },
    ],
  };
  assert.deepEqual(errs({ kind: 'cell', cellKey: 'a_b_c' }, schema), []);
  // Without the discriminator this would be an unhelpful "matches none of 2".
  assert.deepEqual(errs({ kind: 'cell' }, schema), ['cellKey: is required']);
  assert.deepEqual(errs({ kind: 'nope' }, schema), ['<root>: matches none of the 2 allowed shapes']);
});

test('a bad type short-circuits, so one mistake does not cascade', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
  assert.deepEqual(errs('not an object', schema), ['<root>: must be object, got string']);
});

test('the shipped report schema is itself well-formed enough to accept a minimal document', async () => {
  const { readFileSync } = await import('node:fs');
  const { paths } = await import('../config.ts');
  const schema = JSON.parse(readFileSync(paths.reportSchema, 'utf8')) as JsonSchema;
  // Deliberately empty: every top-level required key should be reported, which
  // proves the schema's `required` list is reachable through $ref/$defs.
  const missing = validateAgainstSchema({}, schema).map((e) => e.path);
  assert.ok(missing.includes('schemaVersion'));
  assert.ok(missing.includes('findings'));
  assert.ok(missing.includes('results'));
});
