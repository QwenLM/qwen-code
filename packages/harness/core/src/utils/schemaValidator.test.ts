/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SchemaValidator } from './schemaValidator.js';

describe('SchemaValidator', () => {
  describe.each([
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2020-12/schema',
  ])('unsupported parameter diagnostics (%s)', ($schema) => {
    it('identifies the unsupported field and its parent without including its value', () => {
      const params = { options: { '-l': 'private value' } };
      const schema = {
        $schema,
        type: 'object',
        properties: {
          options: { type: 'object', additionalProperties: false },
        },
      };
      const failure = SchemaValidator.validateWithDetails(schema, params);

      expect(failure?.message).toBe(
        'An unexpected parameter `options.-l` was provided',
      );
      expect(SchemaValidator.validateStrict(schema, params)).toBe(
        failure?.message,
      );
      expect(failure?.errors[0]).toMatchObject({
        keyword: 'additionalProperties',
        instancePath: '/options',
        params: { additionalProperty: '-l' },
        message: 'must NOT have additional properties',
      });
      expect(params).toEqual({ options: { '-l': 'private value' } });
    });

    it('decodes escaped keys and distinguishes array indices from numeric object keys', () => {
      const schema = {
        $schema,
        type: 'object',
        properties: {
          'a/b~c': {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                '0': { type: 'object', additionalProperties: false },
              },
            },
          },
        },
      };
      const params = { 'a/b~c': [{ '0': { '-l': 'private value' } }] };
      const message = 'An unexpected parameter `a/b~c[0].0.-l` was provided';

      expect(SchemaValidator.validate(schema, params)).toBe(message);
      expect(SchemaValidator.validateStrict(schema, params)).toBe(message);
      expect(params).toEqual({ 'a/b~c': [{ '0': { '-l': 'private value' } }] });
    });
  });

  describe.each([
    'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2020-12/schema',
  ])('coerce-on-failure (%s)', ($schema) => {
    const scalar = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    const schema = {
      $schema,
      type: 'object',
      required: ['value'],
      properties: {
        value: {
          oneOf: [
            ...scalar.oneOf,
            { type: 'array', minItems: 1, uniqueItems: true, items: scalar },
          ],
        },
      },
    };

    it.each([
      { value: 123 },
      { value: '123' },
      { value: [123] },
      { value: ['123'] },
      { value: 'abc' },
      { value: ['abc'] },
    ])('accepts a valid union without changing $value', (original) => {
      const params = structuredClone(original);
      expect(
        SchemaValidator.validate(schema, params, 'coerce-on-failure'),
      ).toBeNull();
      expect(params).toEqual(original);
    });

    it.each([{ value: {} }, { value: [] }, { value: ['abc', 'abc'] }, {}])(
      'rejects invalid union input %j',
      (params) => {
        expect(
          SchemaValidator.validate(schema, params, 'coerce-on-failure'),
        ).not.toBeNull();
      },
    );

    it('commits successful number and boolean coercion', () => {
      const params = { offset: '10', enabled: 'true' };
      expect(
        SchemaValidator.validateWithDetails(
          {
            $schema,
            type: 'object',
            properties: {
              offset: { type: 'number' },
              enabled: { type: 'boolean' },
            },
          },
          params,
          'coerce-on-failure',
        ),
      ).toBeNull();
      expect(params).toEqual({ offset: 10, enabled: true });
    });

    it('returns the final constraint error without committing failed coercion', () => {
      const params = { offset: '-1' };
      const failure = SchemaValidator.validateWithDetails(
        {
          $schema,
          type: 'object',
          properties: { offset: { type: 'number', minimum: 0 } },
        },
        params,
        'coerce-on-failure',
      );
      expect(failure?.errors[0].keyword).toBe('minimum');
      expect(failure?.message).toContain('must be >= 0');
      expect(params).toEqual({ offset: '-1' });
    });

    it('still validates known formats', () => {
      expect(
        SchemaValidator.validate(
          {
            $schema,
            type: 'object',
            properties: { date: { type: 'string', format: 'date' } },
          },
          { date: 'not-a-date' },
          'coerce-on-failure',
        ),
      ).not.toBeNull();
    });
  });

  it('keeps coercion enabled by default for existing callers', () => {
    const params = { offset: '10' };
    expect(
      SchemaValidator.validate(
        { type: 'object', properties: { offset: { type: 'number' } } },
        params,
      ),
    ).toBeNull();
    expect(params).toEqual({ offset: 10 });
  });

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

  it('allows schemas with draft-07 $schema property', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      $schema: 'http://json-schema.org/draft-07/schema#',
    };
    const params = { name: 'test' };
    expect(SchemaValidator.validate(schema, params)).toBeNull();
  });

  it.each(['coerce', 'coerce-on-failure'] as const)(
    'allows unsupported schema versions in %s mode',
    (mode) => {
      // Future-proof: any unrecognized schema version should skip validation
      // with a warning rather than failing
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        $schema: 'https://json-schema.org/draft/2030-99/schema',
      };
      const params = { name: 'test' };
      expect(SchemaValidator.validate(schema, params, mode)).toBeNull();
    },
  );

  describe('JSON Schema draft-2020-12 support', () => {
    it('validates params against draft-2020-12 schema', () => {
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          message: {
            type: 'string',
          },
        },
        required: ['message'],
      };

      // Valid data should pass
      expect(SchemaValidator.validate(schema, { message: 'hello' })).toBeNull();
      // Invalid data should fail (proves validation actually works).
      // Note: with coerceTypes enabled, scalars like 123 are coerced to "123",
      // so we use an array which cannot be coerced to a string.
      expect(
        SchemaValidator.validate(schema, { message: ['not', 'a', 'string'] }),
      ).not.toBeNull();
    });

    it('validates draft-2020-12 schema with prefixItems', () => {
      // prefixItems is a draft-2020-12 feature (replaces tuple validation)
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          coords: {
            type: 'array',
            prefixItems: [{ type: 'number' }, { type: 'number' }],
            items: false,
          },
        },
      };

      // Valid: exactly 2 numbers
      expect(SchemaValidator.validate(schema, { coords: [1, 2] })).toBeNull();
      // Invalid: 3 items when items: false
      expect(
        SchemaValidator.validate(schema, { coords: [1, 2, 3] }),
      ).not.toBeNull();
    });

    it('validates draft-2020-12 schema with $defs', () => {
      // draft-2020-12 uses $defs instead of definitions
      const schema = {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: {
          ChatRole: {
            type: 'string',
            enum: ['System', 'User', 'Assistant'],
          },
        },
        properties: {
          role: { $ref: '#/$defs/ChatRole' },
        },
        required: ['role'],
      };

      // Valid enum value
      expect(SchemaValidator.validate(schema, { role: 'User' })).toBeNull();
      // Invalid enum value (proves validation works)
      expect(
        SchemaValidator.validate(schema, { role: 'InvalidRole' }),
      ).not.toBeNull();
    });
  });
});
