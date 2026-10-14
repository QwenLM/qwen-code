/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  prepareWorkflowSchema,
  validateStructuredResult,
  type WorkflowSchemaValidate,
} from './workflow-schema.js';
import { SchemaValidator } from '../../utils/schemaValidator.js';

function prepared(schema: unknown): WorkflowSchemaValidate {
  const result = prepareWorkflowSchema(schema);
  if (!result.ok) throw new Error(`expected a usable schema: ${result.error}`);
  return result.validate;
}

function refusal(schema: unknown): string {
  const result = prepareWorkflowSchema(schema);
  if (result.ok) throw new Error('expected the schema to be refused');
  return result.error;
}

describe('prepareWorkflowSchema', () => {
  describe('refuses a schema that is not a usable JSON Schema object', () => {
    it.each([
      ['null', null],
      ['an array', [{ type: 'object' }]],
      ['a boolean', true],
      ['a string', 'object'],
    ])('%s', (shape, schema) => {
      expect(refusal(schema)).toBe(
        `agent({schema}): must be a JSON Schema object, got ${shape}.`,
      );
    });

    it.each([
      ['a non-string type', { type: 42 }],
      ['an unknown keyword', { type: 'object', propertees: {} }],
      ['an unresolvable $ref', { $ref: '#/$defs/Missing' }],
      ['a remote $ref', { $ref: 'https://example.com/schema.json' }],
      [
        'an unsupported draft',
        { $schema: 'https://json-schema.org/draft/2019-09/schema' },
      ],
      ['a malformed required', { type: 'object', required: 'x' }],
    ])('%s', (_name, schema) => {
      expect(refusal(schema)).toMatch(
        /^agent\(\{schema\}\): is not a valid JSON Schema: /,
      );
    });

    it('an asynchronous schema, before it can validate anything', () => {
      const unhandled: unknown[] = [];
      const listener = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', listener);
      try {
        expect(
          refusal({
            $async: true,
            type: 'object',
            required: ['n'],
            properties: { n: { type: 'number' } },
          }),
        ).toContain('uses $async');
      } finally {
        process.off('unhandledRejection', listener);
      }
      expect(unhandled).toEqual([]);
    });

    it('an asynchronous subschema under a synchronous root', () => {
      expect(
        refusal({
          type: 'object',
          properties: { x: { $ref: '#/definitions/A' } },
          definitions: { A: { $async: true, type: 'string' } },
        }),
      ).toMatch(/^agent\(\{schema\}\): /);
    });

    it('strips control characters from the reason', () => {
      const error = refusal({ type: 'object', 'bad\u001b[31mkey': 1 });
      // eslint-disable-next-line no-control-regex
      expect(error).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });
  });

  describe('contradictions', () => {
    it('names a required property a closed object forbids', () => {
      expect(
        refusal({
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary', 'answer'],
          additionalProperties: false,
        }),
      ).toBe(
        'agent({schema}): #/required/1 requires "answer", but this object forbids it via additionalProperties:false (it is not in properties and matches no patternProperties).',
      );
    });

    it('names a required property whose schema is false', () => {
      expect(
        refusal({
          type: 'object',
          properties: { 'a/b~c': false },
          required: ['a/b~c'],
        }),
      ).toBe(
        'agent({schema}): #/required/0 requires "a/b~c", but #/properties/a~1b~0c is false, which forbids it.',
      );
    });

    it('names a required property a patternProperties false forbids', () => {
      expect(
        refusal({
          type: 'object',
          patternProperties: { '^x': false },
          required: ['xy'],
        }),
      ).toContain('#/patternProperties/^x is false');
    });

    it('names more required properties than maxProperties allows', () => {
      expect(
        refusal({
          type: 'object',
          required: ['a', 'b', 'c'],
          maxProperties: 2,
        }),
      ).toBe(
        'agent({schema}): #/required lists 3 distinct properties, but #/maxProperties allows at most 2.',
      );
    });

    it.each([
      [{ type: 'string' }, 'type "string"'],
      [{ type: ['string', 'null'] }, 'type ["string","null"]'],
      [{ const: 'x' }, 'its const is not an object'],
      [{ enum: ['a', 1] }, 'its enum has no object member'],
    ])('refuses a root that excludes every object: %j', (schema, reason) => {
      expect(refusal(schema)).toContain(reason);
    });

    it('follows required object-only properties to a nested contradiction', () => {
      expect(
        refusal({
          type: 'object',
          required: ['outer'],
          properties: {
            outer: {
              type: 'object',
              required: ['inner'],
              additionalProperties: false,
            },
          },
        }),
      ).toContain('#/properties/outer/required/0 requires "inner"');
    });

    // Each schema below accepts at least one object, shown by the witness.
    it.each([
      [
        'an optional false property',
        { type: 'object', properties: { x: false } },
        {},
      ],
      [
        'a required nullable object whose own rules are impossible',
        {
          type: 'object',
          required: ['x'],
          properties: {
            x: {
              type: ['object', 'null'],
              required: ['y'],
              additionalProperties: false,
            },
          },
        },
        { x: null },
      ],
      [
        'a required object marked nullable',
        {
          type: 'object',
          required: ['x'],
          properties: {
            x: {
              type: 'object',
              nullable: true,
              required: ['y'],
              additionalProperties: false,
            },
          },
        },
        { x: null },
      ],
      [
        'a required key matched by patternProperties',
        {
          type: 'object',
          patternProperties: { '^x$': { type: 'string' } },
          required: ['x'],
          additionalProperties: false,
        },
        { x: 'ok' },
      ],
      [
        'required without properties on an open object',
        { type: 'object', required: ['x'] },
        { x: 1 },
      ],
      [
        'an optional impossible property',
        {
          type: 'object',
          properties: {
            optional: {
              type: 'object',
              required: ['x'],
              additionalProperties: false,
            },
          },
        },
        {},
      ],
      [
        'an impossible branch that is not the only choice',
        {
          anyOf: [
            { type: 'object', required: ['x'], additionalProperties: false },
            { type: 'object' },
          ],
        },
        { y: 1 },
      ],
      [
        'a root $ref',
        {
          $ref: '#/$defs/Output',
          $defs: {
            Output: { type: 'object', properties: { x: { type: 'string' } } },
          },
        },
        { x: 'ok' },
      ],
      [
        'an unreferenced impossible definition',
        {
          type: 'object',
          definitions: {
            Never: {
              type: 'object',
              required: ['x'],
              additionalProperties: false,
            },
          },
        },
        {},
      ],
      [
        'an impossible array item, avoided by an empty array',
        {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['x'],
                additionalProperties: false,
              },
            },
          },
        },
        { items: [] },
      ],
      [
        'a draft-2020-12 schema with a trailing #',
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema#',
          type: 'object',
          properties: {
            tags: { type: 'array', prefixItems: [{ type: 'string' }] },
          },
        },
        { tags: ['a'] },
      ],
      [
        'enum data that looks like a schema',
        {
          type: 'object',
          properties: {
            kind: { enum: [{ required: ['x'], additionalProperties: false }] },
          },
        },
        {},
      ],
    ])('accepts %s', (_name, schema, witness) => {
      const validate = prepared(schema);
      expect(validate(witness)).toBeNull();
    });
  });

  describe('properties that also match patternProperties', () => {
    const overlapping = {
      type: 'object',
      properties: { foo: { type: 'string' } },
      patternProperties: { '^f': { minLength: 1 } },
      required: ['foo'],
    };

    it('prepares the schema and enforces both constraints', () => {
      const validate = prepared(overlapping);
      expect(validate({ foo: 'ok' })).toBeNull();
      expect(validate({ foo: '' })).toContain(
        'must NOT have fewer than 1 characters',
      );
      expect(validate({})).toContain("required property 'foo'");
    });

    it('still refuses an unknown keyword next to the overlap', () => {
      expect(refusal({ ...overlapping, propertees: {} })).toMatch(
        /^agent\(\{schema\}\): is not a valid JSON Schema: /,
      );
    });
  });

  describe('validation', () => {
    it('keeps the four coercion passes of tool parameter validation', () => {
      const validate = prepared({
        type: 'object',
        properties: {
          flag: { type: 'boolean' },
          label: { type: 'string' },
          list: { type: 'array', items: { type: 'string' } },
          count: { type: 'integer' },
          either: { type: ['string', 'number'] },
        },
      });
      const value: Record<string, unknown> = {
        flag: 'true',
        label: 7,
        list: '["a"]',
        count: '3',
        either: 4,
      };
      expect(validate(value)).toBeNull();
      expect(value).toEqual({
        flag: true,
        label: '7',
        list: ['a'],
        count: 3,
        either: 4,
      });
    });

    it('checks known formats and tolerates unknown ones', () => {
      const validate = prepared({
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          id: { type: 'string', format: 'uint64' },
        },
      });
      expect(validate({ email: 'a@b.co', id: 'anything' })).toBeNull();
      expect(validate({ email: 'not-an-email' })).toContain('format');
    });

    it('refuses a missing required property on the first call', () => {
      expect(prepared({ type: 'object', required: ['answer'] })({})).toContain(
        "must have required property 'answer'",
      );
    });

    it('does not let a shared $id skip validation', () => {
      const first = prepared({
        $id: 'https://example.com/out',
        type: 'object',
        required: ['a'],
      });
      const second = prepared({
        $id: 'https://example.com/out',
        type: 'object',
        required: ['b'],
      });
      expect(second({})).toContain("required property 'b'");
      expect(first({})).toContain("required property 'a'");
      expect(second({ a: 1 })).toContain("required property 'b'");
      expect(first({ b: 1 })).toContain("required property 'a'");
      expect(second({ b: 1 })).toBeNull();
    });

    it('does not let an $id the shared validator claimed skip validation', () => {
      const schema = { $id: 'https://example.com/claimed', type: 'object' };
      expect(SchemaValidator.validate(schema, {})).toBeNull();
      const validate = prepared({
        $id: 'https://example.com/claimed',
        type: 'object',
        required: ['x'],
      });
      expect(validate({})).toContain("required property 'x'");
    });

    it('is not changed by later changes to the caller schema', () => {
      const schema: Record<string, unknown> = {
        type: 'object',
        required: ['x'],
      };
      const validate = prepared(schema);
      schema['required'] = [];
      expect(validate({})).toContain("required property 'x'");
    });
  });
});

describe('validateStructuredResult', () => {
  const validate = prepared({
    type: 'object',
    properties: { n: { type: 'number' } },
    required: ['n'],
  });

  it('returns a validated, coerced copy and leaves the value alone', () => {
    const value = { n: '5' };
    const checked = validateStructuredResult(value, validate);
    expect(checked).toEqual({ value: { n: 5 } });
    expect(value).toEqual({ n: '5' });
  });

  it.each([null, 'text', [1], 3])('refuses a non-object %j', (value) => {
    expect(validateStructuredResult(value, validate)).toEqual({
      error: 'the result is not a JSON object',
    });
  });

  it('reports why an object does not pass', () => {
    expect(validateStructuredResult({}, validate)).toEqual({
      error: expect.stringContaining("required property 'n'"),
    });
  });

  it('reports a validator that throws instead of throwing', () => {
    expect(
      validateStructuredResult({}, () => {
        throw new Error('boom');
      }),
    ).toEqual({ error: 'boom' });
  });
});
