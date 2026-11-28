/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SchemaValidator } from './schemaValidator.js';
import {
  zodToToolJsonSchema,
  zodToToolPropertyJsonSchema,
} from './zodToolJsonSchema.js';

describe('zodToToolJsonSchema', () => {
  it('declares the input shape the model sends', () => {
    const schema = z
      .object({
        summary: z.string().describe('A summary'),
        count: z.number().int().min(0),
        level: z.enum(['low', 'high']),
        note: z.string().nullable(),
        mode: z.string().default('fast'),
        parsed: z.string().transform(Number),
        meta: z.record(z.string(), z.unknown()).optional(),
      })
      .describe('Report');

    expect(zodToToolJsonSchema(schema)).toEqual({
      type: 'object',
      description: 'Report',
      properties: {
        summary: { type: 'string', description: 'A summary' },
        count: { type: 'integer', minimum: 0 },
        level: { type: 'string', enum: ['low', 'high'] },
        note: { type: ['string', 'null'] },
        mode: { type: 'string', default: 'fast' },
        parsed: { type: 'string' },
        meta: { type: 'object', additionalProperties: {} },
      },
      required: ['summary', 'count', 'level', 'note', 'parsed'],
      additionalProperties: false,
    });
  });

  it('keeps unknown-key handling of each object', () => {
    const schema = z.object({
      strip: z.object({ a: z.string() }),
      strict: z.object({ a: z.string() }).strict(),
      loose: z.object({ a: z.string() }).passthrough(),
    });
    const properties = zodToToolJsonSchema(schema)['properties'] as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties['strip']['additionalProperties']).toBe(false);
    expect(properties['strict']['additionalProperties']).toBe(false);
    expect(properties['loose']['additionalProperties']).toEqual({});
  });

  it('inlines a schema reused in several places', () => {
    const shared = z.object({ id: z.string() });
    const json = zodToToolJsonSchema(
      z.object({ first: shared, second: shared }),
    );

    expect(JSON.stringify(json)).not.toContain('$ref');
  });
});

describe('zodToToolPropertyJsonSchema', () => {
  it('nests the schema as a single required property', () => {
    expect(
      zodToToolPropertyJsonSchema('answer', z.string().optional()),
    ).toEqual({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    });
  });

  it('keeps recursive references resolvable after nesting', () => {
    const node: z.ZodType<{ name: string; children: unknown[] }> = z.object({
      name: z.string(),
      get children() {
        return z.array(node);
      },
    });
    const json = zodToToolPropertyJsonSchema('tree', node);

    expect(json['definitions']).toBeDefined();
    expect(SchemaValidator.validateSchema(json)).toBeNull();
    expect(
      SchemaValidator.validate(json, {
        tree: { name: 'root', children: [{ name: 'leaf', children: [] }] },
      }),
    ).toBeNull();
    expect(
      SchemaValidator.validate(json, {
        tree: { name: 'root', children: [{ children: [] }] },
      }),
    ).not.toBeNull();
  });
});
