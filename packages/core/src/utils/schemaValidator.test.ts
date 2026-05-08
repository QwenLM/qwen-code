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
});
