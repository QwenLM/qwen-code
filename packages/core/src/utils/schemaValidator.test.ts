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
});
