/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  convertSchema,
  relaxSchemaForFunctionCalling,
} from './schemaConverter.js';

describe('convertSchema', () => {
  describe('mode: auto (default)', () => {
    it('should preserve type arrays', () => {
      const input = { type: ['string', 'null'] };
      expect(convertSchema(input, 'auto')).toEqual(input);
    });

    it('should preserve items array (tuples)', () => {
      const input = {
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
      };
      expect(convertSchema(input, 'auto')).toEqual(input);
    });

    it('should preserve mixed enums', () => {
      const input = { enum: [1, 2, '3'] };
      expect(convertSchema(input, 'auto')).toEqual(input);
    });

    it('should preserve unsupported keywords', () => {
      const input = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        exclusiveMinimum: 10,
        type: 'number',
      };
      expect(convertSchema(input, 'auto')).toEqual(input);
    });
  });

  describe('mode: openapi_30 (strict)', () => {
    it('should convert type arrays to nullable', () => {
      const input = { type: ['string', 'null'] };
      const expected = { type: 'string', nullable: true };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should fallback to first type for non-nullable arrays', () => {
      const input = { type: ['string', 'number'] };
      const expected = { type: 'string' };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should not emit null as the fallback type for nullable unions', () => {
      const input = { type: ['null', 'string', 'number'] };
      const expected = { type: 'string', nullable: true };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should fall back to the original type when all types are null', () => {
      const input = { type: ['null'] };
      const expected = { type: 'null', nullable: true };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should convert const to enum', () => {
      const input = { const: 'foo' };
      const expected = { enum: ['foo'] };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should stringify a non-string const like any other enum', () => {
      // `enum: [1, 2]` becomes `['1', '2']` because Gemini requires string
      // enums; a const-derived enum is the same kind of value and must obey
      // the same rule.
      expect(convertSchema({ const: 5 }, 'openapi_30')).toEqual({
        enum: ['5'],
      });
      expect(convertSchema({ const: true }, 'openapi_30')).toEqual({
        enum: ['true'],
      });
      expect(
        convertSchema({ type: 'integer', const: 0 }, 'openapi_30'),
      ).toEqual({ type: 'integer', enum: ['0'] });
    });

    it('should convert exclusiveMinimum number to boolean', () => {
      const input = { type: 'number', exclusiveMinimum: 10 };
      const expected = {
        type: 'number',
        minimum: 10,
        exclusiveMinimum: true,
      };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should keep a Draft 4 boolean exclusive limit instead of dropping it', () => {
      expect(
        convertSchema(
          { type: 'number', minimum: 10, exclusiveMinimum: true },
          'openapi_30',
        ),
      ).toEqual({ type: 'number', minimum: 10, exclusiveMinimum: true });
      expect(
        convertSchema(
          { type: 'number', maximum: 10, exclusiveMaximum: true },
          'openapi_30',
        ),
      ).toEqual({ type: 'number', maximum: 10, exclusiveMaximum: true });
    });

    it('should keep a nested Draft 4 boolean exclusive limit', () => {
      expect(
        convertSchema(
          {
            type: 'object',
            properties: {
              pct: { type: 'number', minimum: 0, exclusiveMinimum: true },
            },
          },
          'openapi_30',
        ),
      ).toEqual({
        type: 'object',
        properties: {
          pct: { type: 'number', minimum: 0, exclusiveMinimum: true },
        },
      });
    });

    it('should be idempotent for exclusive limits', () => {
      const once = convertSchema(
        { type: 'number', exclusiveMinimum: 10 },
        'openapi_30',
      );
      expect(convertSchema(once, 'openapi_30')).toEqual(once);
    });

    // Guard against over-correcting: the numeric form must still be CONSUMED
    // by step 3 rather than passed through, or the boolean it writes would be
    // overwritten by the number and the output would stop being Draft 4.
    it('should not pass a numeric exclusive limit through unconverted', () => {
      const result = convertSchema(
        { type: 'number', exclusiveMaximum: 5 },
        'openapi_30',
      );
      expect(result['exclusiveMaximum']).toBe(true);
      expect(result['maximum']).toBe(5);
    });

    it('should convert nested objects recursively', () => {
      const input = {
        type: 'object',
        properties: {
          prop1: { type: ['integer', 'null'], exclusiveMaximum: 5 },
        },
      };
      const expected = {
        type: 'object',
        properties: {
          prop1: {
            type: 'integer',
            nullable: true,
            maximum: 5,
            exclusiveMaximum: true,
          },
        },
      };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should convert nested nullable union fallbacks recursively', () => {
      const input = {
        type: 'object',
        properties: {
          prop1: { type: ['null', 'object', 'string'] },
        },
      };
      const expected = {
        type: 'object',
        properties: {
          prop1: { type: 'object', nullable: true },
        },
      };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should stringify enums', () => {
      const input = { enum: [1, 2, '3'] };
      const expected = { enum: ['1', '2', '3'] };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should remove tuple items (array of schemas)', () => {
      const input = {
        type: 'array',
        items: [{ type: 'string' }, { type: 'number' }],
      };
      const expected = { type: 'array' };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('should remove unsupported keywords', () => {
      const input = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: '#foo',
        type: 'string',
        default: 'bar',
        dependencies: { foo: ['bar'] },
        patternProperties: { '^foo': { type: 'string' } },
      };
      const expected = { type: 'string' };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('never treats property names as schema keywords', () => {
      // `properties` keys are names, not keywords. Walking the map as if it
      // were a schema node makes each step misfire on a colliding name: the
      // const step replaces a property called `const` with a bogus `enum`,
      // the skip list drops one called `default`, and one called `type` is
      // copied verbatim instead of being converted.
      const input = {
        type: 'object',
        properties: {
          type: { type: ['string', 'null'], description: 'a prop named type' },
          const: { type: 'string', enum: [1, 2] },
          default: { type: 'boolean' },
          enum: { type: ['integer', 'null'] },
          items: { type: 'string' },
          $schema: { type: 'string' },
          dependencies: { type: 'string' },
          patternProperties: { type: 'string' },
        },
        required: ['type'],
      };
      const expected = {
        type: 'object',
        properties: {
          // Converted as a schema, not read as a `type` keyword.
          type: {
            type: 'string',
            nullable: true,
            description: 'a prop named type',
          },
          const: { type: 'string', enum: ['1', '2'] },
          default: { type: 'boolean' },
          enum: { type: 'integer', nullable: true },
          items: { type: 'string' },
          $schema: { type: 'string' },
          dependencies: { type: 'string' },
          patternProperties: { type: 'string' },
        },
        required: ['type'],
      };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('converts $defs and definitions as name maps too', () => {
      const input = {
        type: 'object',
        $defs: { const: { type: ['string', 'null'] } },
        definitions: { default: { type: ['number', 'null'] } },
      };
      const expected = {
        type: 'object',
        $defs: { const: { type: 'string', nullable: true } },
        definitions: { default: { type: 'number', nullable: true } },
      };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });

    it('still removes keyword-level unsupported fields beside a map', () => {
      // The map guard must not become an escape hatch for the real keywords:
      // a top-level `$schema` is still dropped even when a property shares
      // its name.
      const input = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: '#foo',
        type: 'object',
        properties: { $schema: { type: 'string' } },
      };
      const expected = {
        type: 'object',
        properties: { $schema: { type: 'string' } },
      };
      expect(convertSchema(input, 'openapi_30')).toEqual(expected);
    });
  });
});

// Regression for #7315: gateways enforcing OpenAI's structured-output
// contract promote every property to required when an object level carries
// `additionalProperties: false` — mutually exclusive optional tool fields
// (Agent working_dir vs isolation) become impossible to satisfy.
describe('relaxSchemaForFunctionCalling', () => {
  it('strips additionalProperties:false on levels with optional properties', () => {
    const agentLike = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
        working_dir: { type: 'string' },
        isolation: { type: 'string', enum: ['worktree'] },
      },
      required: ['description', 'prompt'],
      additionalProperties: false,
    };
    const relaxed = relaxSchemaForFunctionCalling(agentLike);
    expect(relaxed['additionalProperties']).toBeUndefined();
    expect(relaxed['$schema']).toBeUndefined();
    expect(relaxed['required']).toEqual(['description', 'prompt']);
    expect(Object.keys(relaxed['properties'] as object)).toEqual([
      'description',
      'prompt',
      'working_dir',
      'isolation',
    ]);
  });

  it('keeps additionalProperties:false when every property is required', () => {
    const strictSchema = {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    };
    expect(
      relaxSchemaForFunctionCalling(strictSchema)['additionalProperties'],
    ).toBe(false);
  });

  it('keeps additionalProperties:false when there are no properties to promote', () => {
    const empty = { type: 'object', additionalProperties: false };
    expect(relaxSchemaForFunctionCalling(empty)['additionalProperties']).toBe(
      false,
    );
  });

  it('relaxes nested object levels independently', () => {
    const nested = {
      type: 'object',
      properties: {
        outerRequired: {
          type: 'object',
          properties: {
            x: { type: 'string' },
            y: { type: 'string' },
          },
          required: ['x'],
          additionalProperties: false,
        },
        strictInner: {
          type: 'object',
          properties: { z: { type: 'string' } },
          required: ['z'],
          additionalProperties: false,
        },
      },
      required: ['outerRequired', 'strictInner'],
      additionalProperties: false,
    };
    const relaxed = relaxSchemaForFunctionCalling(nested) as {
      additionalProperties?: unknown;
      properties: Record<string, { additionalProperties?: unknown }>;
    };
    // Top level: all props required -> constraint kept.
    expect(relaxed.additionalProperties).toBe(false);
    // Inner with an optional property -> stripped.
    expect(
      relaxed.properties['outerRequired']!.additionalProperties,
    ).toBeUndefined();
    // Inner fully required -> kept.
    expect(relaxed.properties['strictInner']!.additionalProperties).toBe(false);
  });

  it('preserves non-false additionalProperties forms and recurses into them', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: {
        type: 'object',
        properties: { inner: { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
    };
    const relaxed = relaxSchemaForFunctionCalling(schema) as {
      additionalProperties: { additionalProperties?: unknown };
    };
    expect(typeof relaxed.additionalProperties).toBe('object');
    expect(relaxed.additionalProperties.additionalProperties).toBeUndefined();
  });

  it('never treats property names as schema keywords', () => {
    // `properties` keys are names, not keywords: a property literally
    // called $schema / $id / uniqueItems / additionalProperties must survive
    // the walk.
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.com/tool.schema.json',
      type: 'object',
      properties: {
        $schema: { type: 'string' },
        $id: { type: 'string' },
        uniqueItems: { type: 'boolean' },
        additionalProperties: { type: 'boolean' },
      },
      required: ['$schema', '$id', 'uniqueItems', 'additionalProperties'],
      additionalProperties: false,
      $defs: {
        $schema: { type: 'number' },
      },
    };
    const relaxed = relaxSchemaForFunctionCalling(schema) as {
      $schema?: unknown;
      $id?: unknown;
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: unknown;
      $defs: Record<string, unknown>;
    };
    // Keyword-level $schema AND $id dropped; property-level names intact.
    expect(relaxed.$schema).toBeUndefined();
    expect(relaxed.$id).toBeUndefined();
    expect(Object.keys(relaxed.properties)).toEqual([
      '$schema',
      '$id',
      'uniqueItems',
      'additionalProperties',
    ]);
    expect(relaxed.required).toEqual([
      '$schema',
      '$id',
      'uniqueItems',
      'additionalProperties',
    ]);
    // All properties required -> the constraint keyword stays.
    expect(relaxed.additionalProperties).toBe(false);
    // $defs is a name map too.
    expect(Object.keys(relaxed.$defs)).toEqual(['$schema']);
  });

  it('removes uniqueItems recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        evidenceRefs: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string' },
        },
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              blockedBy: {
                type: 'array',
                uniqueItems: true,
                items: { type: 'string' },
              },
            },
          },
        },
        disabled: {
          type: 'array',
          uniqueItems: false,
          items: { type: 'string' },
        },
      },
    };

    expect(relaxSchemaForFunctionCalling(schema)).toEqual({
      type: 'object',
      properties: {
        evidenceRefs: {
          type: 'array',
          items: { type: 'string' },
        },
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              blockedBy: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
        disabled: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
  });

  it('never treats schema-map keys as schema keywords', () => {
    const namedUniqueItems = { uniqueItems: { type: 'string' } };
    const schema = {
      type: 'object',
      patternProperties: namedUniqueItems,
      dependencies: namedUniqueItems,
      dependentSchemas: namedUniqueItems,
      dependentRequired: { uniqueItems: ['value'] },
    };

    expect(relaxSchemaForFunctionCalling(schema)).toEqual(schema);
  });

  it('does not treat JSON literal values as nested schemas', () => {
    const literal = { uniqueItems: true, $schema: 'literal' };
    const schema = {
      type: 'object',
      const: literal,
      default: literal,
      enum: [literal],
      example: literal,
      examples: [literal],
    };

    const relaxed = relaxSchemaForFunctionCalling(schema) as {
      const: Record<string, unknown>;
    };
    expect(relaxed).toEqual(schema);
    expect(relaxed.const).not.toBe(schema.const);
  });

  it('does not mutate the input schema', () => {
    const input = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: [],
      additionalProperties: false,
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    relaxSchemaForFunctionCalling(input);
    expect(input).toEqual(snapshot);
  });
});
