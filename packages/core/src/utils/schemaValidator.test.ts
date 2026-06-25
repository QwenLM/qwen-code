/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SchemaValidator } from './schemaValidator.js';

describe('SchemaValidator', () => {
  it('should allow any params if schema is undefined', () => {
    const params = {
      foo: 'bar',
    };
    expect(SchemaValidator.validate(undefined, params)).toBeNull();
  });

  it('rejects null params', () => {
    const schema = {
      type: 'object',
      properties: {
        foo: {
          type: 'string',
        },
      },
    };
    expect(SchemaValidator.validate(schema, null)).toBe(
      'Value of params must be an object',
    );
  });

  it('rejects params that are not objects', () => {
    const schema = {
      type: 'object',
      properties: {
        foo: {
          type: 'string',
        },
      },
    };
    expect(SchemaValidator.validate(schema, 'not an object')).toBe(
      'Value of params must be an object',
    );
  });

  it('allows schema with extra properties', () => {
    const schema = {
      type: 'object',
      properties: {
        example_enum: {
          type: 'string',
          enum: ['FOO', 'BAR'],
          // enum-descriptions is not part of the JSON schema spec.
          // This test verifies that the SchemaValidator allows the
          // use of extra keywords, like this one, in the schema.
          'enum-descriptions': ['a foo', 'a bar'],
        },
      },
    };
    const params = {
      example_enum: 'BAR',
    };

    expect(SchemaValidator.validate(schema, params)).toBeNull();
  });

  it('allows custom format values', () => {
    const schema = {
      type: 'object',
      properties: {
        duration: {
          type: 'string',
          // See: https://cloud.google.com/docs/discovery/type-format
          format: 'google-duration',
        },
        mask: {
          type: 'string',
          format: 'google-fieldmask',
        },
        foo: {
          type: 'string',
          format: 'something-totally-custom',
        },
      },
    };
    const params = {
      duration: '10s',
      mask: 'foo.bar,biz.baz',
      foo: 'some value',
    };
    expect(SchemaValidator.validate(schema, params)).toBeNull();
  });

  it('allows valid values for known formats', () => {
    const schema = {
      type: 'object',
      properties: {
        today: {
          type: 'string',
          format: 'date',
        },
      },
    };
    const params = {
      today: '2025-04-08',
    };
    expect(SchemaValidator.validate(schema, params)).toBeNull();
  });

  it('rejects invalid values for known formats', () => {
    const schema = {
      type: 'object',
      properties: {
        today: {
          type: 'string',
          format: 'date',
        },
      },
    };
    const params = {
      today: 'this is not a date',
    };
    expect(SchemaValidator.validate(schema, params)).not.toBeNull();
  });

  describe('boolean string coercion', () => {
    const booleanSchema = {
      type: 'object',
      properties: {
        is_background: {
          type: 'boolean',
        },
      },
      required: ['is_background'],
    };

    it('should coerce string "true" to boolean true', () => {
      const params = { is_background: 'true' };
      expect(SchemaValidator.validate(booleanSchema, params)).toBeNull();
      expect(params.is_background).toBe(true);
    });

    it('should coerce string "True" to boolean true', () => {
      const params = { is_background: 'True' };
      expect(SchemaValidator.validate(booleanSchema, params)).toBeNull();
      expect(params.is_background).toBe(true);
    });

    it('should coerce string "TRUE" to boolean true', () => {
      const params = { is_background: 'TRUE' };
      expect(SchemaValidator.validate(booleanSchema, params)).toBeNull();
      expect(params.is_background).toBe(true);
    });

    it('should coerce string "false" to boolean false', () => {
      const params = { is_background: 'false' };
      expect(SchemaValidator.validate(booleanSchema, params)).toBeNull();
      expect(params.is_background).toBe(false);
    });

    it('should coerce string "False" to boolean false', () => {
      const params = { is_background: 'False' };
      expect(SchemaValidator.validate(booleanSchema, params)).toBeNull();
      expect(params.is_background).toBe(false);
    });

    it('should coerce string "FALSE" to boolean false', () => {
      const params = { is_background: 'FALSE' };
      expect(SchemaValidator.validate(booleanSchema, params)).toBeNull();
      expect(params.is_background).toBe(false);
    });

    it('should handle nested objects with string booleans', () => {
      const nestedSchema = {
        type: 'object',
        properties: {
          options: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
          },
        },
      };
      const params = { options: { enabled: 'true' } };
      expect(SchemaValidator.validate(nestedSchema, params)).toBeNull();
      expect((params.options as unknown as { enabled: boolean }).enabled).toBe(
        true,
      );
    });

    it('should not affect non-boolean strings', () => {
      const mixedSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          is_active: { type: 'boolean' },
        },
      };
      const params = { name: 'trueman', is_active: 'true' };
      expect(SchemaValidator.validate(mixedSchema, params)).toBeNull();
      expect(params.name).toBe('trueman');
      expect(params.is_active).toBe(true);
    });

    it('should not corrupt string fields whose value is literally "true"/"false"', () => {
      const mixedSchema = {
        type: 'object',
        properties: {
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          is_active: { type: 'boolean' },
        },
        required: ['old_string', 'new_string', 'is_active'],
      };
      // A self-hosted LLM sends `is_active` as the string "false" (the case this
      // coercion exists for) which fails initial validation and triggers
      // fixBooleanValues. The string-typed `old_string`/`new_string` arguments
      // legitimately hold the text "true"/"false" and must survive untouched —
      // previously they were rewritten into booleans, corrupting the edit.
      const params = {
        old_string: 'true',
        new_string: 'false',
        is_active: 'false',
      };
      expect(SchemaValidator.validate(mixedSchema, params)).toBeNull();
      expect(params.old_string).toBe('true');
      expect(params.new_string).toBe('false');
      expect(params.is_active).toBe(false);
    });

    it('should preserve string "true"/"false" when the field also accepts string', () => {
      // When a field accepts both boolean AND string (a common Pydantic /
      // draft-2020-12 union), a string value of "true"/"false" is legitimate
      // — e.g. user content that happens to be the text "true"/"false" — and
      // must NOT be coerced to a boolean. Coercing it would corrupt the tool
      // call. Mirrors main's pre-existing guard and the symmetric guard in
      // fixStringValues. Previously this regressed vs main (the string was
      // silently rewritten into a boolean).
      const unionSchema = {
        type: 'object',
        properties: {
          value: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          is_active: { type: 'boolean' },
        },
        required: ['value', 'is_active'],
      };
      const params = { value: 'false', is_active: 'false' };
      expect(SchemaValidator.validate(unionSchema, params)).toBeNull();
      // value accepts string → the string "false" is preserved, not coerced.
      expect(params.value).toBe('false');
      // is_active is boolean-only → still coerced to false.
      expect(params.is_active).toBe(false);
    });

    it('should coerce string booleans inside arrays of booleans', () => {
      const arraySchema = {
        type: 'object',
        properties: {
          flags: { type: 'array', items: { type: 'boolean' } },
        },
        required: ['flags'],
      };
      const params = { flags: ['true', 'false', 'true'] };
      expect(SchemaValidator.validate(arraySchema, params)).toBeNull();
      expect(params.flags).toEqual([true, false, true]);
    });

    it('should pass through actual boolean values unchanged', () => {
      const params = { is_background: true };
      expect(SchemaValidator.validate(booleanSchema, params)).toBeNull();
      expect(params.is_background).toBe(true);
    });
  });

  describe('stringified JSON value coercion', () => {
    it('should coerce stringified array for anyOf [array, null]', () => {
      const schema = {
        type: 'object',
        properties: {
          urls: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
            default: null,
          },
        },
      };
      const params = { urls: '["https://example.com"]' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.urls).toEqual(['https://example.com']);
    });

    it('should coerce stringified object for anyOf [object, null]', () => {
      const schema = {
        type: 'object',
        properties: {
          config: {
            anyOf: [
              {
                type: 'object',
                properties: { key: { type: 'string' } },
              },
              { type: 'null' },
            ],
          },
        },
      };
      const params = { config: '{"key":"value"}' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.config).toEqual({ key: 'value' });
    });

    it('should coerce stringified array for oneOf [array, null]', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            oneOf: [
              { type: 'array', items: { type: 'integer' } },
              { type: 'null' },
            ],
          },
        },
      };
      const params = { items: '[1, 2, 3]' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.items).toEqual([1, 2, 3]);
    });

    it('should not coerce when schema accepts string type', () => {
      const schema = {
        type: 'object',
        properties: {
          data: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      };
      const params = { data: '["hello"]' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      // Value should remain a string since string is accepted
      expect(params.data).toBe('["hello"]');
    });

    it('should not coerce invalid JSON strings', () => {
      const schema = {
        type: 'object',
        properties: {
          urls: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
          },
        },
      };
      const params = { urls: '[not valid json' };
      expect(SchemaValidator.validate(schema, params)).not.toBeNull();
    });

    it('should not coerce strings that do not look like JSON', () => {
      const schema = {
        type: 'object',
        properties: {
          urls: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
          },
        },
        required: ['urls'],
      };
      const params = { urls: 'hello world' };
      expect(SchemaValidator.validate(schema, params)).not.toBeNull();
    });

    it('should handle stringified array with plain type (no anyOf)', () => {
      // Should NOT coerce when there is no anyOf/oneOf — the schema just
      // says type: array, and a string value is simply invalid.
      const schema = {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' } },
        },
        required: ['urls'],
      };
      const params = { urls: '["https://example.com"]' };
      // No anyOf/oneOf, so fixStringifiedJsonValues won't have types to check
      // against — but getAcceptedTypes reads plain 'type' too, so it should
      // still coerce since 'string' is not in the accepted types.
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.urls).toEqual(['https://example.com']);
    });
  });

  describe('numeric string coercion', () => {
    it('should coerce string "3" to integer 3', () => {
      const schema = {
        type: 'object',
        properties: {
          depth: { type: 'integer' },
        },
        required: ['depth'],
      };
      const params = { depth: '3' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.depth).toBe(3);
    });

    it('should coerce string "5.5" to number 5.5', () => {
      const schema = {
        type: 'object',
        properties: {
          timeout: { type: 'number' },
        },
        required: ['timeout'],
      };
      const params = { timeout: '5.5' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.timeout).toBe(5.5);
    });

    it('should coerce negative numeric strings', () => {
      const schema = {
        type: 'object',
        properties: {
          offset: { type: 'integer' },
        },
        required: ['offset'],
      };
      const params = { offset: '-10' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.offset).toBe(-10);
    });

    it('should not coerce non-numeric strings', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'integer' },
        },
        required: ['count'],
      };
      const params = { count: 'abc' };
      expect(SchemaValidator.validate(schema, params)).not.toBeNull();
    });

    it('should not coerce when schema also accepts string', () => {
      const schema = {
        type: 'object',
        properties: {
          value: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
        },
        required: ['value'],
      };
      const params = { value: '42' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      // Should remain a string since string is accepted
      expect(params.value).toBe('42');
    });

    it('should coerce numeric strings in nested objects', () => {
      const schema = {
        type: 'object',
        properties: {
          options: {
            type: 'object',
            properties: {
              retries: { type: 'integer' },
            },
          },
        },
      };
      const params = { options: { retries: '3' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.options as unknown as { retries: number }).retries).toBe(
        3,
      );
    });

    it('should not affect actual number values', () => {
      const schema = {
        type: 'object',
        properties: {
          depth: { type: 'integer' },
        },
        required: ['depth'],
      };
      const params = { depth: 3 };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.depth).toBe(3);
    });

    it('should not corrupt string fields with numeric-looking values', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
        },
        required: ['name', 'count'],
      };
      const params = { name: '42', count: '7' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.name).toBe('42');
      expect(params.count).toBe(7);
    });

    it('should work with draft-2020-12 schema (MCP servers)', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          time: { type: 'number' },
        },
        required: ['time'],
      };
      const params = { time: '5' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.time).toBe(5);
    });

    it('should not coerce decimal string for integer-only schema', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'integer' },
        },
        required: ['count'],
      };
      const params = { count: '5.5' };
      // Should NOT coerce — let validation fail so LLM self-corrects
      expect(SchemaValidator.validate(schema, params)).not.toBeNull();
      expect(params.count).toBe('5.5');
    });

    it('should coerce decimal string when number is accepted via anyOf', () => {
      const schema = {
        type: 'object',
        properties: {
          value: { anyOf: [{ type: 'integer' }, { type: 'number' }] },
        },
        required: ['value'],
      };
      const params = { value: '5.5' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.value).toBe(5.5);
    });

    it('should coerce whole-number decimal string to integer (e.g. "3.0")', () => {
      const schema = {
        type: 'object',
        properties: {
          depth: { type: 'integer' },
        },
        required: ['depth'],
      };
      const params = { depth: '3.0' };
      // "3.0" represents an integer — coerce it rather than rejecting.
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.depth).toBe(3);
    });

    it('should coerce numeric strings inside arrays of integers', () => {
      const schema = {
        type: 'object',
        properties: {
          ports: { type: 'array', items: { type: 'integer' } },
        },
        required: ['ports'],
      };
      const params = { ports: ['8080', '3000'] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.ports).toEqual([8080, 3000]);
    });
  });

  describe('JSON Schema version support', () => {
    it('should support JSON Schema draft-2020-12', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      };
      const params = { url: 'https://example.com' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
    });

    it('should validate correctly with draft-2020-12 schema', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          count: { type: 'integer' },
        },
        required: ['count'],
      };
      const validParams = { count: 42 };
      const invalidParams = { count: 'not a number' };

      expect(SchemaValidator.validate(schema, validParams)).toBeNull();
      expect(SchemaValidator.validate(schema, invalidParams)).not.toBeNull();
    });

    it('should support JSON Schema draft-07 (default)', () => {
      const schema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };
      const params = { name: 'test' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
    });

    it('should handle nested schemas with $schema', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          config: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
          },
        },
      };
      const params = { config: { enabled: true } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
    });

    it('should support 2020-12 specific keywords like prefixItems', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'integer' }],
      };
      const params = ['hello', 42];
      expect(SchemaValidator.validate(schema, params)).toBeNull();
    });

    it('should handle anyOf union types with draft-2020-12', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          urls: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
            default: null,
          },
        },
      };
      expect(
        SchemaValidator.validate(schema, {
          urls: ['https://example.com'],
        }),
      ).toBeNull();
      expect(SchemaValidator.validate(schema, { urls: null })).toBeNull();
      expect(SchemaValidator.validate(schema, {})).toBeNull();
    });

    it('should gracefully handle unsupported schema versions', () => {
      // draft-2019-09 is not supported by Ajv by default
      const schema = {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      };
      const params = { value: 'test' };
      // Should skip validation and return null (graceful degradation)
      expect(SchemaValidator.validate(schema, params)).toBeNull();
    });
  });

  describe('compileStrict', () => {
    it('returns null for a simple valid schema', () => {
      expect(
        SchemaValidator.compileStrict({
          type: 'object',
          properties: { foo: { type: 'string' } },
        }),
      ).toBeNull();
    });

    it('returns null for draft-2020-12 schemas', () => {
      expect(
        SchemaValidator.compileStrict({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
        }),
      ).toBeNull();
    });

    it('returns null for empty object schema', () => {
      expect(SchemaValidator.compileStrict({})).toBeNull();
    });

    it('returns an error string when type keyword has an illegal value', () => {
      const err = SchemaValidator.compileStrict({ type: 42 });
      expect(err).not.toBeNull();
      expect(typeof err).toBe('string');
    });

    it('returns a descriptive error when schema is not an object', () => {
      expect(SchemaValidator.compileStrict(null)).toMatch(/JSON object/);
      expect(SchemaValidator.compileStrict(undefined)).toMatch(/JSON object/);
      expect(SchemaValidator.compileStrict('a string')).toMatch(/JSON object/);
    });

    it('rejects arrays even though typeof === "object"', () => {
      // Arrays satisfy `typeof === 'object'` but are not valid JSON Schema
      // root values; the prior guard accepted them and let the misleading
      // error surface from Ajv much later.
      expect(SchemaValidator.compileStrict([])).toMatch(/JSON object/);
      expect(SchemaValidator.compileStrict([{ type: 'string' }])).toMatch(
        /JSON object/,
      );
    });

    it('flags unknown keywords (typos) under strict mode', () => {
      // The shared SchemaValidator.validate is intentionally lenient
      // (`strictSchema: false`) so MCP-style custom keywords don't break
      // runtime validation. compileStrict is the explicit user-supplied
      // surface and should NOT swallow typos like `propertees`.
      const err = SchemaValidator.compileStrict({
        type: 'object',
        propertees: { foo: { type: 'string' } },
      });
      expect(err).not.toBeNull();
      expect(err).toMatch(/propert/i);
    });

    it('accepts type-union arrays under allowUnionTypes', () => {
      // Strict mode rejects `type: ["a","b"]` by default; we opt in via
      // allowUnionTypes because spec-valid type unions are common in
      // real-world schemas (e.g. nullable fields). Without this, a
      // schema like `{type:["object","null"]}` would have failed at
      // CLI parse time even though it's valid JSON Schema.
      expect(
        SchemaValidator.compileStrict({
          type: 'object',
          properties: { x: { type: ['string', 'number'] } },
        }),
      ).toBeNull();
      expect(
        SchemaValidator.compileStrict({ type: ['object', 'null'] }),
      ).toBeNull();
    });

    it('accepts spec-valid schemas that Ajv `strict: true` would reject', () => {
      // The previous `strict: true` setting enabled lint rules beyond
      // JSON-Schema validity (strictRequired / strictTypes /
      // validateFormats), which rejected real-world spec-valid schemas
      // and broke `--json-schema` for legitimate users.

      // strictRequired: required without listing in properties.
      expect(
        SchemaValidator.compileStrict({
          type: 'object',
          required: ['answer'],
        }),
      ).toBeNull();

      // strictTypes: nested const/enum without explicit type.
      expect(
        SchemaValidator.compileStrict({
          type: 'object',
          properties: { mode: { enum: ['a', 'b'] } },
        }),
      ).toBeNull();

      // validateFormats: unknown custom format string.
      expect(
        SchemaValidator.compileStrict({
          type: 'object',
          properties: { id: { type: 'string', format: 'snowflake-id' } },
        }),
      ).toBeNull();
    });

    it('accepts the draft-2020-12 URI with a trailing `#` fragment', () => {
      // Both `…/schema` and `…/schema#` reference the same meta-schema;
      // exact-equality on the canonical URI rejected the trailing-`#`
      // form, falling back to the draft-07 Ajv and surfacing as
      // `no schema with key or ref ...`. Real schemas in the wild
      // include the `#` because spec examples often do.
      expect(
        SchemaValidator.compileStrict({
          $schema: 'https://json-schema.org/draft/2020-12/schema#',
          type: 'object',
          properties: { foo: { type: 'string' } },
        }),
      ).toBeNull();
    });
  });

  describe('non-string to string coercion', () => {
    const schema = {
      type: 'object',
      properties: {
        old_string: { type: 'string' },
        content: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['old_string', 'content'],
    };

    it('should coerce number values to strings', () => {
      const params = { old_string: 123, content: 'hello' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.old_string).toBe('123');
    });

    it('should coerce boolean values to strings', () => {
      const params = { old_string: true, content: false };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.old_string).toBe('true');
      expect(params.content).toBe('false');
    });

    it('should not coerce values that are already strings', () => {
      const params = { old_string: 'original', content: 'text' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.old_string).toBe('original');
    });

    it('should not coerce non-string schema fields', () => {
      const params = { old_string: 'text', content: 'hello', count: 42 };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.count).toBe(42);
    });

    it('should coerce float to string', () => {
      const params = { old_string: 3.14, content: 'hello' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.old_string).toBe('3.14');
    });

    it('should not coerce objects or arrays to strings', () => {
      const params = { old_string: { x: 1 }, content: 'hello' };
      expect(SchemaValidator.validate(schema, params)).not.toBeNull();
      expect(params.old_string).toEqual({ x: 1 });

      const arrayParams = { old_string: [1, 2, 3], content: 'hello' };
      expect(SchemaValidator.validate(schema, arrayParams)).not.toBeNull();
      expect(arrayParams.old_string).toEqual([1, 2, 3]);
    });

    it('should coerce nested string fields', () => {
      const nestedSchema = {
        type: 'object',
        properties: {
          options: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              enabled: { type: 'boolean' },
            },
          },
        },
      };
      const params = { options: { label: 42, enabled: true } };
      expect(SchemaValidator.validate(nestedSchema, params)).toBeNull();
      const opts = params.options as unknown as {
        label: string;
        enabled: boolean;
      };
      expect(opts.label).toBe('42');
      expect(opts.enabled).toBe(true);
    });

    it('should not coerce null values', () => {
      const params = { old_string: null, content: 'hello' };
      SchemaValidator.validate(schema, params);
      // null is left in place — validation result depends on schema nullability
      expect(params.old_string).toBeNull();
    });

    it('should handle bigint values', () => {
      const params = { old_string: BigInt(9007199254740991), content: 'hello' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.old_string).toBe('9007199254740991');
    });

    it('should not coerce already-valid integers in union types', () => {
      const unionSchema = {
        type: 'object',
        properties: {
          val: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
          bad_field: { type: 'number' },
        },
        required: ['val', 'bad_field'],
      };
      // val=42 is already valid as integer, bad_field causes the failure
      const params = { val: 42, bad_field: 'not_a_number' };
      SchemaValidator.validate(unionSchema, params);
      // val should NOT be coerced to '42' — it was already valid as integer
      expect(params.val).toBe(42);
    });

    it('should coerce primitives in string arrays', () => {
      const arraySchema = {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
          bad_field: { type: 'number' },
        },
        required: ['tags', 'bad_field'],
      };
      const params = { tags: [1, 2.5, true], bad_field: 'not_a_number' };
      SchemaValidator.validate(arraySchema, params);
      expect(params.tags).toEqual(['1', '2.5', 'true']);
    });
  });

  describe('schema-aware boolean coercion', () => {
    it('should not coerce "true" on enum-only schemas', () => {
      const enumSchema = {
        type: 'object',
        properties: {
          status: { enum: ['active', 'true', 'false'] },
          count: { type: 'number' },
        },
        required: ['count'],
      };
      // count missing causes validation failure → coercion runs
      const params = { status: 'true' };
      SchemaValidator.validate(enumSchema, params);
      // "true" should NOT be coerced to boolean — enum-only schema has no boolean type
      expect(params.status).toBe('true');
    });

    it('should not coerce "true" on const-only schemas', () => {
      const constSchema = {
        type: 'object',
        properties: {
          answer: { const: 'true' },
          count: { type: 'number' },
        },
        required: ['count'],
      };
      const params = { answer: 'true' };
      SchemaValidator.validate(constSchema, params);
      expect(params.answer).toBe('true');
    });

    it('should not corrupt string arrays with boolean-like elements', () => {
      const schema = {
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = {
        tags: ['active', 'True', 'false'],
        bad_field: 'not_a_number',
      };
      SchemaValidator.validate(schema, params);
      expect(params.tags).toEqual(['active', 'True', 'false']);
    });

    it('should not coerce blindly in nested objects without schema', () => {
      const schema = {
        type: 'object',
        properties: {
          config: { type: 'object' },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      // config has type:object but no properties defined — nested fields are unconstrained
      const params = {
        config: { name: 'True', mode: 'false' },
        bad_field: 'not_a_number',
      };
      SchemaValidator.validate(schema, params);
      // Strings should NOT be coerced — no schema info for nested fields
      expect((params.config as Record<string, unknown>)['name']).toBe('True');
      expect((params.config as Record<string, unknown>)['mode']).toBe('false');
    });
  });

  describe('nested stringified JSON coercion', () => {
    it('should coerce stringified array in nested objects', () => {
      const schema = {
        type: 'object',
        properties: {
          outer: {
            type: 'object',
            properties: {
              inner: {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      };
      const params = { outer: { inner: '["url"]' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.outer as Record<string, unknown>)['inner']).toEqual([
        'url',
      ]);
    });
  });

  describe('allOf support in getAcceptedTypes', () => {
    it('should coerce number to string when type is defined via allOf', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { allOf: [{ type: 'string' }] },
        },
      };
      const params = { name: 42 };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.name).toBe('42');
    });

    it('should coerce string to boolean when type is defined via allOf', () => {
      const schema = {
        type: 'object',
        properties: {
          flag: { allOf: [{ type: 'boolean' }] },
        },
      };
      const params = { flag: 'true' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.flag).toBe(true);
    });
  });

  describe('integer/number subtype handling', () => {
    it('should not coerce integers when schema accepts number via anyOf', () => {
      const schema = {
        type: 'object',
        properties: {
          val: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          bad_field: { type: 'number' },
        },
        required: ['val', 'bad_field'],
      };
      // 42 is an integer, which is a subtype of number — should not coerce
      const params = { val: 42, bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      expect(params.val).toBe(42);
    });

    it('should not coerce integers in arrays when items accept number', () => {
      const schema = {
        type: 'object',
        properties: {
          vals: {
            type: 'array',
            items: { anyOf: [{ type: 'number' }, { type: 'string' }] },
          },
          bad_field: { type: 'number' },
        },
        required: ['vals', 'bad_field'],
      };
      const params = { vals: [1, 2, 3], bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      expect(params.vals).toEqual([1, 2, 3]);
    });
  });

  describe('deeply nested composition keywords', () => {
    it('should resolve types from nested allOf containing anyOf', () => {
      const schema = {
        type: 'object',
        properties: {
          val: {
            allOf: [{ anyOf: [{ type: 'string' }, { type: 'integer' }] }],
          },
        },
      };
      const params = { val: 42 };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      // 42 is integer, which is accepted by the nested anyOf
      expect(params.val).toBe(42);
    });

    it('should coerce to string when nested allOf/anyOf defines string type', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { allOf: [{ anyOf: [{ type: 'string' }] }] },
        },
      };
      const params = { name: 42 };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.name).toBe('42');
    });
  });

  describe('fixBooleanValues with arrays', () => {
    it('should coerce primitives in boolean arrays', () => {
      const schema = {
        type: 'object',
        properties: {
          flags: { type: 'array', items: { type: 'boolean' } },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = {
        flags: ['true', 'false', 'True'],
        bad_field: 'not_a_number',
      };
      SchemaValidator.validate(schema, params);
      expect(params.flags).toEqual([true, false, true]);
    });

    it('should coerce booleans in arrays of objects', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { enabled: { type: 'boolean' } },
            },
          },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = {
        items: [{ enabled: 'true' }, { enabled: 'false' }],
        bad_field: 'not_a_number',
      };
      SchemaValidator.validate(schema, params);
      expect(params.items).toEqual([{ enabled: true }, { enabled: false }]);
    });

    it('should preserve string "true"/"false" in arrays whose items also accept string', () => {
      // items schema accepts boolean AND string → a string element of
      // "true"/"false" is legitimate and must not be coerced to a boolean.
      // Mirrors the scalar-field guard; covers the uniform-items path.
      const schema = {
        type: 'object',
        properties: {
          values: {
            type: 'array',
            items: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          },
          flags: { type: 'array', items: { type: 'boolean' } },
        },
        required: ['values', 'flags'],
      };
      const params = { values: ['true', 'false'], flags: ['true', 'false'] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      // values accept string → strings preserved.
      expect(params.values).toEqual(['true', 'false']);
      // flags are boolean-only → still coerced.
      expect(params.flags).toEqual([true, false]);
    });

    it('should preserve string "true"/"false" in tuple elements that also accept string', () => {
      // prefixItems tuple where position 0 accepts boolean AND string → a
      // string element of "true"/"false" there must not be coerced, while
      // position 1 (boolean-only) is still coerced. Covers the per-element
      // (prefixItems) path. bad_field forces initial validation to fail so the
      // coercion pass runs and walks prefixItems.
      const schema = {
        type: 'object',
        properties: {
          pair: {
            type: 'array',
            prefixItems: [
              { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
              { type: 'boolean' },
            ],
          },
          bad_field: { type: 'integer' },
        },
        required: ['pair', 'bad_field'],
      };
      const params = { pair: ['false', 'false'], bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      // Position 0 accepts string → preserved; position 1 is boolean-only → coerced.
      expect(params.pair).toEqual(['false', false]);
    });
  });

  describe('fixStringValues with oneOf', () => {
    it('should not coerce already-valid integers in oneOf types', () => {
      const schema = {
        type: 'object',
        properties: {
          val: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
          bad_field: { type: 'number' },
        },
        required: ['val', 'bad_field'],
      };
      const params = { val: 42, bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      expect(params.val).toBe(42);
    });
  });

  describe('fixStringifiedJsonValues with arrays', () => {
    it('should coerce stringified JSON in arrays of objects', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                tags: {
                  anyOf: [
                    { type: 'array', items: { type: 'string' } },
                    { type: 'null' },
                  ],
                },
              },
            },
          },
        },
      };
      const params = { items: [{ tags: '["a","b"]' }, { tags: '["c"]' }] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.items).toEqual([{ tags: ['a', 'b'] }, { tags: ['c'] }]);
    });

    it('should coerce stringified JSON via allOf', () => {
      const schema = {
        type: 'object',
        properties: {
          data: { allOf: [{ type: 'array', items: { type: 'string' } }] },
        },
      };
      const params = { data: '["x","y"]' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.data).toEqual(['x', 'y']);
    });
  });

  describe('$ref resolution', () => {
    it('should coerce number to string via $ref', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { $ref: '#/definitions/NameProp' },
        },
        definitions: {
          NameProp: { type: 'string' },
        },
      };
      const params = { name: 42 };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.name).toBe('42');
    });

    it('should coerce string to boolean via $ref in $defs', () => {
      const schema = {
        type: 'object',
        properties: {
          flag: { $ref: '#/$defs/FlagProp' },
        },
        $defs: {
          FlagProp: { type: 'boolean' },
        },
      };
      const params = { flag: 'true' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.flag).toBe(true);
    });

    it('should coerce stringified JSON via $ref', () => {
      const schema = {
        type: 'object',
        properties: {
          urls: { $ref: '#/definitions/UrlsProp' },
        },
        definitions: {
          UrlsProp: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'null' },
            ],
          },
        },
      };
      const params = { urls: '["https://example.com"]' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.urls).toEqual(['https://example.com']);
    });

    it('should handle unresolvable $ref gracefully', () => {
      const schema = {
        type: 'object',
        properties: {
          val: { $ref: '#/definitions/MissingDef' },
        },
      };
      const params = { val: 'true' };
      // Unresolvable $ref — coercion should be skipped, not crash
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
    });
  });

  describe('fixStringValues array-of-objects recursion', () => {
    it('should coerce string fields in arrays of objects', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                count: { type: 'integer' },
              },
            },
          },
        },
      };
      const params = {
        items: [
          { name: 42, count: 5 },
          { name: true, count: 0 },
        ],
      };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.items).toEqual([
        { name: '42', count: 5 },
        { name: 'true', count: 0 },
      ]);
    });
  });

  describe('NaN/Infinity guard', () => {
    it('should not coerce NaN to string', () => {
      const schema = {
        type: 'object',
        properties: {
          val: { type: 'string' },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = { val: NaN, bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      // NaN should NOT be coerced to "NaN"
      expect(params.val).toBeNaN();
    });

    it('should not coerce Infinity to string', () => {
      const schema = {
        type: 'object',
        properties: {
          val: { type: 'string' },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = { val: Infinity, bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      // Infinity should NOT be coerced to "Infinity"
      expect(params.val).toBe(Infinity);
    });
  });

  describe('additionalProperties fallback', () => {
    it('should coerce values in additionalProperties schemas', () => {
      const schema = {
        type: 'object',
        additionalProperties: { type: 'string' },
      };
      const params = { key1: 42, key2: true, key3: 'already_string' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.key1).toBe('42');
      expect(params.key2).toBe('true');
      expect(params.key3).toBe('already_string');
    });

    it('should coerce boolean strings in additionalProperties', () => {
      const schema = {
        type: 'object',
        additionalProperties: { type: 'boolean' },
      };
      const params = { flag1: 'true', flag2: 'false' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.flag1).toBe(true);
      expect(params.flag2).toBe(false);
    });
  });

  describe('$ref resolution in nested object recursion', () => {
    it('should coerce booleans in nested objects via $ref', () => {
      // Finding #1: $ref must be resolved before recursion into nested objects
      const schema = {
        type: 'object',
        properties: {
          config: { $ref: '#/$defs/Config' },
        },
        $defs: {
          Config: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
          },
        },
      };
      const params = { config: { enabled: 'true' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.config as Record<string, unknown>)['enabled']).toBe(true);
    });

    it('should coerce strings in nested objects via $ref in definitions', () => {
      const schema = {
        type: 'object',
        properties: {
          settings: { $ref: '#/definitions/Settings' },
        },
        definitions: {
          Settings: {
            type: 'object',
            properties: {
              label: { type: 'string' },
            },
          },
        },
      };
      const params = { settings: { label: 42 } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.settings as Record<string, unknown>)['label']).toBe('42');
    });

    it('should coerce stringified JSON in nested objects via $ref', () => {
      const schema = {
        type: 'object',
        properties: {
          data: { $ref: '#/$defs/Data' },
        },
        $defs: {
          Data: {
            type: 'object',
            properties: {
              tags: {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      };
      const params = { data: { tags: '["a","b"]' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.data as Record<string, unknown>)['tags']).toEqual([
        'a',
        'b',
      ]);
    });
  });

  describe('circular $ref protection', () => {
    it('should not crash on circular $ref', () => {
      // Finding #2: circular $ref should not cause stack overflow
      const schema = {
        type: 'object',
        properties: {
          node: { $ref: '#/$defs/Node' },
        },
        $defs: {
          Node: {
            type: 'object',
            properties: {
              value: { type: 'string' },
              child: { $ref: '#/$defs/Node' },
            },
          },
        },
      };
      const params = { node: { value: 42, child: null } };
      // Should not throw / stack overflow
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
    });

    it('should handle deeply nested anyOf without stack overflow', () => {
      // Finding #6: deeply nested composition keywords should not crash
      // Build a schema with deep nesting of anyOf (exceeds depth-64 limit)
      let inner: Record<string, unknown> = { type: 'string' };
      for (let i = 0; i < 100; i++) {
        inner = { anyOf: [inner, { type: 'null' }] };
      }
      const schema = {
        type: 'object',
        properties: {
          val: inner,
        },
      };
      const params = { val: 42 };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
      // Depth limit (64) is exceeded, so getAcceptedTypes returns null and
      // coercion is skipped — value stays unchanged. This is the safe behavior.
      expect(params.val).toBe(42);
    });
  });

  describe('additionalProperties recursion', () => {
    it('should coerce booleans in nested additionalProperties', () => {
      // Finding #3: additionalProperties-only schemas should recurse
      const schema = {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: { type: 'boolean' },
        },
      };
      const params = { a: { b: 'true', c: 'false' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.a as Record<string, unknown>)['b']).toBe(true);
      expect((params.a as Record<string, unknown>)['c']).toBe(false);
    });

    it('should coerce strings in nested additionalProperties', () => {
      const schema = {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      };
      const params = { outer: { inner: 42 } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.outer as Record<string, unknown>)['inner']).toBe('42');
    });
  });

  describe('arrays of arrays coercion', () => {
    it('should coerce stringified JSON in arrays of arrays', () => {
      // Finding #4: fixStringifiedJsonValues should recurse into nested arrays
      const schema = {
        type: 'object',
        properties: {
          matrix: {
            type: 'array',
            items: {
              type: 'array',
              items: {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
            },
          },
        },
      };
      const params = { matrix: [['["a"]'], ['["b","c"]']] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.matrix).toEqual([[['a']], [['b', 'c']]]);
    });
  });

  describe('boolean/string round-trip safety', () => {
    it('should not coerce "true" when schema accepts both boolean and string', () => {
      // Finding #5: anyOf: [boolean, string] with input "true" — the string
      // "true" is already valid (string is accepted), so validation passes
      // and no coercion runs at all. No round-trip occurs.
      const schema = {
        type: 'object',
        properties: {
          val: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
        },
      };
      const params = { val: 'true' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      // "true" is a valid string — no coercion needed
      expect(params.val).toBe('true');
    });

    it('should preserve string when coercion runs due to other failure', () => {
      // When coercion runs (triggered by required_num failing), the string
      // "true" must stay a string: fixBooleanValues skips it (string is also
      // accepted) and fixStringValues skips it (it is already a string). No
      // round-trip or corruption occurs. Previously fixBooleanValues coerced
      // "true" → true here, regressing vs main.
      const schema = {
        type: 'object',
        properties: {
          val: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          required_num: { type: 'integer' },
        },
        required: ['val', 'required_num'],
      };
      const params = { val: 'true', required_num: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      // val accepts string → the string "true" is preserved untouched.
      expect(params.val).toBe('true');
    });

    it('should preserve string in tuple position when schema accepts both', () => {
      // Same invariant as above, but for prefixItems tuples.
      // Position 0: anyOf [boolean, string] with value "true" → stays a string.
      // Position 1: string with value "hello" → stays a string.
      const schema = {
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
              { type: 'string' },
            ],
          },
          required_num: { type: 'integer' },
        },
        required: ['tuple', 'required_num'],
      };
      const params = { tuple: ['true', 'hello'], required_num: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      // Position 0 accepts string → preserved; position 1 stays a string.
      expect(params.tuple).toEqual(['true', 'hello']);
    });
  });

  describe('resolveRef prototype pollution guard', () => {
    it('should not resolve $ref to __proto__', () => {
      // Finding #7: $ref of "#/__proto__" should not resolve to Object.prototype
      const schema = {
        type: 'object',
        properties: {
          val: { $ref: '#/__proto__' },
        },
      };
      const params = { val: 'anything' };
      // Should not throw or resolve to Object.prototype
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
    });

    it('should not resolve $ref to constructor', () => {
      const schema = {
        type: 'object',
        properties: {
          val: { $ref: '#/constructor' },
        },
      };
      const params = { val: 'anything' };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
    });
  });

  describe('multi-hop $ref chains', () => {
    it('should resolve $ref chains of 2+ hops', () => {
      // $defs/A -> $defs/B -> { type: 'string' }
      const schema = {
        type: 'object',
        properties: {
          name: { $ref: '#/$defs/A' },
        },
        $defs: {
          A: { $ref: '#/$defs/B' },
          B: { type: 'string' },
        },
      };
      const params = { name: 42 };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.name).toBe('42');
    });

    it('should resolve deep $ref chains (3 hops)', () => {
      // $defs/A -> $defs/B -> $defs/C -> { type: 'boolean' }
      const schema = {
        type: 'object',
        properties: {
          flag: { $ref: '#/$defs/A' },
        },
        $defs: {
          A: { $ref: '#/$defs/B' },
          B: { $ref: '#/$defs/C' },
          C: { type: 'boolean' },
        },
      };
      const params = { flag: 'true' };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.flag).toBe(true);
    });
  });

  describe('$ref inside composition variants', () => {
    it('should coerce via $ref inside anyOf variants', () => {
      const schema = {
        type: 'object',
        properties: {
          config: {
            anyOf: [{ $ref: '#/$defs/Config' }, { type: 'null' }],
          },
        },
        $defs: {
          Config: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
          },
        },
      };
      const params = { config: { enabled: 'true' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.config as Record<string, unknown>)['enabled']).toBe(true);
    });

    it('should coerce strings via $ref inside anyOf variants', () => {
      const schema = {
        type: 'object',
        properties: {
          data: {
            anyOf: [{ $ref: '#/$defs/Data' }, { type: 'null' }],
          },
        },
        $defs: {
          Data: {
            type: 'object',
            properties: { label: { type: 'string' } },
          },
        },
      };
      const params = { data: { label: 42 } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.data as Record<string, unknown>)['label']).toBe('42');
    });

    it('should coerce via $ref inside oneOf variants', () => {
      const schema = {
        type: 'object',
        properties: {
          config: {
            oneOf: [{ $ref: '#/$defs/Config' }, { type: 'null' }],
          },
        },
        $defs: {
          Config: {
            type: 'object',
            properties: { enabled: { type: 'boolean' } },
          },
        },
      };
      const params = { config: { enabled: 'true' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.config as Record<string, unknown>)['enabled']).toBe(true);
    });

    it('should coerce via $ref inside allOf variants', () => {
      const schema = {
        type: 'object',
        properties: {
          config: {
            allOf: [{ $ref: '#/$defs/Config' }],
          },
        },
        $defs: {
          Config: {
            type: 'object',
            properties: { label: { type: 'string' } },
          },
        },
      };
      const params = { config: { label: 42 } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.config as Record<string, unknown>)['label']).toBe('42');
    });
  });

  describe('Object.hasOwn regression', () => {
    it('should coerce property named toString (Object.prototype shadow)', () => {
      // Regression test: getEffectiveProperties uses Object.hasOwn instead of
      // `in` to avoid prototype chain traversal. Without this guard, a schema
      // property named 'toString' would be silently skipped because
      // 'toString' in {} is true (found on Object.prototype).
      const schema = {
        type: 'object',
        properties: {
          obj: {
            anyOf: [
              {
                type: 'object',
                properties: { toString: { type: 'string' } },
              },
              { type: 'null' },
            ],
          },
        },
      };
      const params = { obj: { toString: 42 } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.obj as Record<string, unknown>)['toString']).toBe('42');
    });
  });

  describe('composition keyword recursion', () => {
    it('should recurse into nested objects wrapped in allOf', () => {
      // allOf wrapping object schema with properties
      const schema = {
        type: 'object',
        properties: {
          config: {
            allOf: [
              {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                },
              },
            ],
          },
        },
      };
      const params = { config: { enabled: 'true' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.config as Record<string, unknown>)['enabled']).toBe(true);
    });

    it('should recurse into nested objects wrapped in anyOf', () => {
      const schema = {
        type: 'object',
        properties: {
          config: {
            anyOf: [
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                },
              },
              { type: 'null' },
            ],
          },
        },
      };
      const params = { config: { label: 42 } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.config as Record<string, unknown>)['label']).toBe('42');
    });

    it('should recurse into arrays of objects wrapped in allOf', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              allOf: [
                {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean' },
                  },
                },
              ],
            },
          },
        },
      };
      const params = { items: [{ enabled: 'true' }, { enabled: 'false' }] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.items).toEqual([{ enabled: true }, { enabled: false }]);
    });

    it('should coerce stringified JSON in nested objects wrapped in allOf', () => {
      const schema = {
        type: 'object',
        properties: {
          data: {
            allOf: [
              {
                type: 'object',
                properties: {
                  tags: {
                    anyOf: [
                      { type: 'array', items: { type: 'string' } },
                      { type: 'null' },
                    ],
                  },
                },
              },
            ],
          },
        },
      };
      const params = { data: { tags: '["a","b"]' } };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect((params.data as Record<string, unknown>)['tags']).toEqual([
        'a',
        'b',
      ]);
    });
  });

  describe('prefixItems (tuple) coercion', () => {
    it('should coerce stringified JSON in tuple with prefixItems-only schema', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              {
                anyOf: [
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' },
                ],
              },
              { type: 'string' },
            ],
          },
        },
      };
      const params = { tuple: ['["a","b"]', 'hello'] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.tuple).toEqual([['a', 'b'], 'hello']);
    });

    it('should coerce boolean strings in tuple with prefixItems', () => {
      const schema = {
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [{ type: 'boolean' }, { type: 'string' }],
          },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = { tuple: ['true', 'hello'], bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      expect(params.tuple).toEqual([true, 'hello']);
    });

    it('should coerce non-string values to strings in tuple with prefixItems', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [{ type: 'string' }, { type: 'integer' }],
          },
        },
      };
      const params = { tuple: [42, 7] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.tuple).toEqual(['42', 7]);
    });

    it('should handle mixed prefixItems + items', () => {
      const schema = {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            prefixItems: [{ type: 'boolean' }],
            items: { type: 'string' },
          },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = { data: ['true', 42, 99], bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      // Position 0: prefixItems boolean coercion
      // Positions 1+: items string coercion
      expect(params.data).toEqual([true, '42', '99']);
    });

    it('should skip elements beyond prefixItems range when no items', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [{ type: 'boolean' }],
            items: true, // Accept any additional items without constraint
          },
        },
      };
      const params = { tuple: ['true', 'should_stay', 'also_stay'] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.tuple).toEqual([true, 'should_stay', 'also_stay']);
    });

    it('should recurse into object elements in prefixItems tuple', () => {
      const schema = {
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  name: { type: 'string' },
                },
              },
              { type: 'integer' },
            ],
          },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
      };
      const params = {
        tuple: [{ enabled: 'true', name: 42 }, 99],
        bad_field: 'not_a_number',
      };
      SchemaValidator.validate(schema, params);
      expect(params.tuple).toEqual([{ enabled: true, name: '42' }, 99]);
    });

    it('should resolve $ref inside prefixItems entries', () => {
      const schema = {
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              { $ref: '#/$defs/FlagProp' },
              { $ref: '#/$defs/NameProp' },
            ],
          },
          bad_field: { type: 'number' },
        },
        required: ['bad_field'],
        $defs: {
          FlagProp: { type: 'boolean' },
          NameProp: { type: 'string' },
        },
      };
      const params = { tuple: ['true', 42], bad_field: 'not_a_number' };
      SchemaValidator.validate(schema, params);
      expect(params.tuple).toEqual([true, '42']);
    });

    it('should coerce stringified JSON inside nested tuple elements', () => {
      // Exercises the fixStringifiedJsonValuesInArray path when a tuple
      // element is itself an array with prefixItems (nested tuple).
      // Note: boolean/string passes do NOT recurse into nested array
      // elements (consistent with existing uniform-array behavior).
      // The JSON-stringify pass (pass 3) does recurse.
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              {
                type: 'array',
                prefixItems: [
                  {
                    anyOf: [
                      { type: 'array', items: { type: 'string' } },
                      { type: 'null' },
                    ],
                  },
                  { type: 'string' },
                ],
              },
              { type: 'string' },
            ],
          },
        },
      };
      // tuple[0] = ['["a"]', 'hello'] — an array where position 0 is a
      // JSON string. Pass 3 recurses into the nested array via
      // fixStringifiedJsonValuesInArray, which handles the prefixItems
      // on the inner array and coerces '["a"]' → ['a'].
      const params = { tuple: [['["a"]', 'hello'], 'world'] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.tuple).toEqual([[['a'], 'hello'], 'world']);
    });

    it('should handle stringified JSON array inside nested tuple element', () => {
      // Value at tuple[0] is a JSON string that parses to an array.
      // The outer prefixItems[0] accepts array (not string), so pass 3
      // coerces '["hello"]' → ["hello"]. The inner array is then
      // validated by Ajv against the nested prefixItems schema.
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            prefixItems: [
              {
                type: 'array',
                prefixItems: [{ type: 'string' }],
              },
              { type: 'string' },
            ],
          },
        },
      };
      const params = { tuple: ['["hello"]', 'x'] };
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.tuple).toEqual([['hello'], 'x']);
    });
  });

  describe('getEffectiveProperties prototype pollution guard', () => {
    it('should not coerce data via __proto__-polluted property prototype', () => {
      // Critical: a malicious MCP schema can register
      // `properties: {__proto__: {trigger_field: {type: 'boolean'}}, safe: ...}`.
      // With the unfixed code, `merged['__proto__'] = v` on a plain `{}`
      // triggers the prototype setter, polluting `merged` with `trigger_field`.
      // A subsequent lookup of `merged['trigger_field']` (for a data key not
      // actually defined in the schema) returns the polluted schema and
      // coerces a legitimate 'true' string to boolean.
      //
      // The fix uses Object.create(null) (no prototype chain to pollute)
      // AND skips dangerous keys (__proto__/constructor/prototype) during
      // the copy.
      //
      // A safe sibling property is included so that getEffectiveProperties
      // returns a non-undefined value (the early-return check is
      // `Object.keys(merged).length > 0`; without a sibling, the polluted
      // merged has zero own keys and is treated as empty).
      //
      // A required 'bad' field forces Ajv to fail initially so the coercion
      // passes actually run.
      //
      // JSON.parse is used to make __proto__ an OWN enumerable property.
      // Object-literal `{__proto__: ...}` would set the prototype chain
      // instead and defeat the test.
      const schema = JSON.parse(`{
        "type": "object",
        "properties": {
          "__proto__": { "trigger_field": { "type": "boolean" } },
          "safe": { "type": "string" },
          "bad": { "type": "string" }
        },
        "required": ["bad"]
      }`);
      // Sanity: __proto__ is an own property of schema.properties
      expect(Object.hasOwn(schema.properties, '__proto__')).toBe(true);

      // trigger_field is not a real property of the schema. It happens to
      // match a field inside the __proto__'s value. bad is a number, schema
      // expects a string — Ajv fails, triggering coercion.
      const params = { trigger_field: 'true', bad: 5 };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
      // Without the fix: 'true' would be coerced to true via the polluted
      // prototype. With the fix: trigger_field is not in the schema's own
      // properties and the value stays as a string.
      expect(params.trigger_field).toBe('true');
      // bad should still coerce normally to its expected string type.
      expect(params.bad).toBe('5');
    });

    it('should still coerce legitimate sibling keys when __proto__ is in properties', () => {
      // Defence-in-depth: even if __proto__ is present, legitimate sibling
      // keys must still coerce normally.
      const schema = JSON.parse(`{
        "type": "object",
        "properties": {
          "__proto__": { "type": "boolean" },
          "legitimate": { "type": "string" }
        }
      }`);
      const params = { legitimate: 42 };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
      expect(params.legitimate).toBe('42');
      // Object.prototype must not be modified either.
      expect(
        (Object.prototype as Record<string, unknown>)['polluted'],
      ).toBeUndefined();
    });

    it('should skip constructor and prototype keys as own properties', () => {
      // Use JSON.parse to make constructor/prototype OWN enumerable properties.
      // Include a sibling so getEffectiveProperties returns non-undefined.
      const schema = JSON.parse(`{
        "type": "object",
        "properties": {
          "constructor": { "type": "boolean" },
          "prototype": { "type": "string" },
          "name": { "type": "string" }
        }
      }`);
      // Sanity: all three are own properties of schema.properties
      expect(Object.hasOwn(schema.properties, 'constructor')).toBe(true);
      expect(Object.hasOwn(schema.properties, 'prototype')).toBe(true);
      expect(Object.hasOwn(schema.properties, 'name')).toBe(true);

      const params = { name: 99 };
      expect(() => SchemaValidator.validate(schema, params)).not.toThrow();
      // The safe 'name' key still gets coerced; the dangerous keys are
      // skipped so they cannot fabricate behavior via prototype traversal.
      expect(params.name).toBe('99');
    });
  });

  describe('fixStringifiedJsonValuesInArray element-level schema', () => {
    it('should coerce stringified JSON in nested uniform arrays of objects', () => {
      // Regression: previously getAcceptedTypes was called on the OUTER array
      // schema (yielding {array}), not the element-level schema. Parsed
      // objects would never match {array}, so coercion was silently skipped.
      // The fix resolves the inner items schema before checking accepted types.
      //
      // The data shape is matrix: [ ['{"a":1}'] ] — an array containing an
      // array containing a stringified JSON object. The outer uniform-items
      // pass in fixStringifiedJsonValues dispatches into
      // fixStringifiedJsonValuesInArray for each sub-array.
      const schema = {
        type: 'object',
        properties: {
          matrix: {
            type: 'array',
            items: {
              type: 'array',
              items: { type: 'object' },
            },
          },
        },
      };
      const params = { matrix: [['{"a":1}']] };
      // With the fix, '{"a":1}' is parsed and coerced to {a:1} because the
      // element schema accepts 'object'. Without the fix, the helper would
      // check {array} (the outer schema's type), find no match for 'object',
      // and silently skip — leaving validation to fail with "must be object".
      expect(SchemaValidator.validate(schema, params)).toBeNull();
      expect(params.matrix).toEqual([[{ a: 1 }]]);
    });
  });

  describe('getAcceptedTypes memoization (branching $ref DoS guard)', () => {
    it('collapses an exponentially branching $ref type tree to linear time', () => {
      // Regression guard for the [Critical] review finding (PR #4793): a
      // compact schema can encode an exponentially branching type tree via
      // $ref, e.g.
      //   $defs/D0 = {type: number}
      //   $defs/Dn = {anyOf: [{$ref: Dn-1}, {$ref: Dn-1}]}
      // Before memoization, getAcceptedTypes re-traversed every shared
      // $defs/Dk target once per path reaching it — O(2^depth) calls
      // (~9s at depth 24 on a laptop, projected to days by depth 40). The
      // memoization cache keys on the *resolved* $defs object (shared across
      // all refs to it), collapsing the descent to O(depth).
      //
      // `val` holds a value that is VALID against the branching schema (a
      // number, since D0 accepts number). That keeps Ajv's work linear — it
      // short-circuits anyOf on the first passing branch and emits no
      // exponential error array — so the test bounds memory regardless of
      // depth. A sibling `bad` field fails, triggering the coercion path that
      // calls getAcceptedTypes on the full branching tree for `val`.
      const DEPTH = 24;
      const $defs: Record<string, unknown> = { D0: { type: 'number' } };
      for (let i = 1; i <= DEPTH; i++) {
        $defs[`D${i}`] = {
          anyOf: [{ $ref: `#/$defs/D${i - 1}` }, { $ref: `#/$defs/D${i - 1}` }],
        };
      }
      const schema = {
        type: 'object',
        properties: {
          val: { $ref: `#/$defs/D${DEPTH}` },
          bad: { type: 'string' },
        },
        required: ['val', 'bad'],
        $defs,
      };
      const params = { val: 42, bad: 123 };

      const start = Date.now();
      const result = SchemaValidator.validate(schema, params);
      const elapsed = Date.now() - start;

      expect(result).toBeNull();
      // val is a valid number — its schema accepts number, so it is unchanged.
      expect(params.val).toBe(42);
      // bad is coerced number → string.
      expect(params.bad).toBe('123');
      // Fixed: <50ms. Unfixed (2^24 ≈ 16M getAcceptedTypes calls): ~9s. The
      // 1s budget catches a regression on any realistic hardware without
      // flaking on slow CI (the fixed path does linear work in both Ajv and
      // the coercion passes).
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
