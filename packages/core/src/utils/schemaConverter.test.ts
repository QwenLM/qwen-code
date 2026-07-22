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
    // called $schema / $id / additionalProperties must survive the walk.
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'https://example.com/tool.schema.json',
      type: 'object',
      properties: {
        $schema: { type: 'string' },
        $id: { type: 'string' },
        additionalProperties: { type: 'boolean' },
      },
      required: ['$schema', '$id', 'additionalProperties'],
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
      'additionalProperties',
    ]);
    expect(relaxed.required).toEqual([
      '$schema',
      '$id',
      'additionalProperties',
    ]);
    // All properties required -> the constraint keyword stays.
    expect(relaxed.additionalProperties).toBe(false);
    // $defs is a name map too.
    expect(Object.keys(relaxed.$defs)).toEqual(['$schema']);
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
