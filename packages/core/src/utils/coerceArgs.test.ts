/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  coerceArgsToSchema,
  coerceContainerArgsToSchema,
} from './coerceArgs.js';

describe('coerceArgsToSchema', () => {
  // ---- Passthrough cases ----
  it('returns args unchanged when no properties', () => {
    const args = { a: '1' };
    expect(coerceArgsToSchema(args, undefined)).toBe(args);
  });

  it('returns undefined when args is undefined', () => {
    expect(coerceArgsToSchema(undefined, { a: { type: 'string' } })).toBe(
      undefined,
    );
  });

  it('passes through unknown keys not in schema', () => {
    const result = coerceArgsToSchema(
      { unknown: 'value' },
      { known: { type: 'string' } },
    );
    expect(result).toEqual({ unknown: 'value' });
  });

  it('passes through null values', () => {
    const result = coerceArgsToSchema({ a: null }, { a: { type: 'integer' } });
    expect(result).toEqual({ a: null });
  });

  // ---- Integer coercion ----
  it('coerces string to integer', () => {
    const result = coerceArgsToSchema(
      { count: '42' },
      { count: { type: 'integer' } },
    );
    expect(result).toEqual({ count: 42 });
  });

  it('coerces float string to integer via truncation ("1.0" → 1)', () => {
    const result = coerceArgsToSchema(
      { count: '1.0' },
      { count: { type: 'integer' } },
    );
    expect(result).toEqual({ count: 1 });
  });

  it('leaves non-numeric string as-is for integer', () => {
    const result = coerceArgsToSchema(
      { count: 'abc' },
      { count: { type: 'integer' } },
    );
    expect(result).toEqual({ count: 'abc' });
  });

  // ---- Number coercion ----
  it('coerces string to number', () => {
    const result = coerceArgsToSchema(
      { rate: '3.14' },
      { rate: { type: 'number' } },
    );
    expect(result).toEqual({ rate: 3.14 });
  });

  // ---- Boolean coercion ----
  it('coerces "true" to true', () => {
    const result = coerceArgsToSchema(
      { flag: 'true' },
      { flag: { type: 'boolean' } },
    );
    expect(result).toEqual({ flag: true });
  });

  it('coerces "false" to false', () => {
    const result = coerceArgsToSchema(
      { flag: 'false' },
      { flag: { type: 'boolean' } },
    );
    expect(result).toEqual({ flag: false });
  });

  it('coerces "yes"/"no" to boolean', () => {
    const result = coerceArgsToSchema(
      { a: 'yes', b: 'no' },
      { a: { type: 'boolean' }, b: { type: 'boolean' } },
    );
    expect(result).toEqual({ a: true, b: false });
  });

  it('coerces "1"/"0" to boolean', () => {
    const result = coerceArgsToSchema(
      { a: '1', b: '0' },
      { a: { type: 'boolean' }, b: { type: 'boolean' } },
    );
    expect(result).toEqual({ a: true, b: false });
  });

  // ---- String coercion ----
  it('coerces number to string', () => {
    const result = coerceArgsToSchema(
      { label: 42 },
      { label: { type: 'string' } },
    );
    expect(result).toEqual({ label: '42' });
  });

  it('coerces boolean to string', () => {
    const result = coerceArgsToSchema(
      { label: true },
      { label: { type: 'string' } },
    );
    expect(result).toEqual({ label: 'true' });
  });

  // ---- Double-encoded array ----
  it('parses double-encoded array', () => {
    const result = coerceArgsToSchema(
      { items: '["a", "b"]' },
      { items: { type: 'array', items: { type: 'string' } } },
    );
    expect(result).toEqual({ items: ['a', 'b'] });
  });

  it('parses double-encoded array with surrounding newlines', () => {
    const result = coerceArgsToSchema(
      { items: '\n["a", "b"]\n' },
      { items: { type: 'array', items: { type: 'string' } } },
    );
    expect(result).toEqual({ items: ['a', 'b'] });
  });

  it('coerces array element types', () => {
    const result = coerceArgsToSchema(
      { nums: ['1', '2', '3'] },
      { nums: { type: 'array', items: { type: 'integer' } } },
    );
    expect(result).toEqual({ nums: [1, 2, 3] });
  });

  // ---- Double-encoded object ----
  it('parses double-encoded object', () => {
    const result = coerceArgsToSchema(
      { config: '{"key": "val"}' },
      {
        config: {
          type: 'object',
          properties: { key: { type: 'string' } },
        },
      },
    );
    expect(result).toEqual({ config: { key: 'val' } });
  });

  // ---- Nested coercion ----
  it('recursively coerces nested object properties', () => {
    const result = coerceArgsToSchema(
      { opts: { count: '5', enabled: 'true' } },
      {
        opts: {
          type: 'object',
          properties: {
            count: { type: 'integer' },
            enabled: { type: 'boolean' },
          },
        },
      },
    );
    expect(result).toEqual({ opts: { count: 5, enabled: true } });
  });

  // ---- Union type schema ----
  it('handles union type ["string", "null"]', () => {
    const result = coerceArgsToSchema(
      { val: 42 },
      { val: { type: ['string', 'null'] } },
    );
    expect(result).toEqual({ val: '42' });
  });

  // ---- Union type arrays: already-valid members must not be flipped ----
  it.each([
    { schema: { type: ['string', 'number'] }, value: 777 },
    { schema: { type: ['number', 'string'] }, value: 777 },
    { schema: { type: ['string', 'number'] }, value: '777' },
    { schema: { type: ['number', 'string'] }, value: '777' },
    { schema: { type: ['string', 'boolean'] }, value: true },
    { schema: { type: ['boolean', 'string'] }, value: false },
    { schema: { type: ['integer', 'string'] }, value: 7 },
    { schema: { type: ['string', 'null'] }, value: 'abc' },
    { schema: { type: ['null', 'string'] }, value: 'abc' },
    { schema: { type: ['array', 'string'] }, value: ['a', 1] },
    { schema: { type: ['object', 'string'] }, value: { a: 1 } },
    { schema: { type: ['array', 'string'] }, value: '[1,2]' },
    { schema: { type: ['object', 'string'] }, value: '{"n":1}' },
  ])(
    'keeps union member value $value unchanged for type %j',
    ({ schema, value }) => {
      const result = coerceArgsToSchema({ val: value }, { val: schema });
      expect(result).toEqual({ val: value });
      expect(typeof result?.['val']).toBe(typeof value);
    },
  );

  it('keeps union members unchanged inside array items', () => {
    const result = coerceArgsToSchema(
      { nums: [1, '2', 3.5] },
      { nums: { type: 'array', items: { type: ['string', 'number'] } } },
    );
    expect(result).toEqual({ nums: [1, '2', 3.5] });
  });

  it('keeps union members unchanged inside nested object properties', () => {
    const result = coerceArgsToSchema(
      { opts: { n: 42, s: '99' } },
      {
        opts: {
          type: 'object',
          properties: {
            n: { type: ['string', 'number'] },
            s: { type: ['number', 'string'] },
          },
        },
      },
    );
    expect(result).toEqual({ opts: { n: 42, s: '99' } });
  });

  it('still coerces to the first member when the value matches none', () => {
    const result = coerceArgsToSchema(
      { val: true },
      { val: { type: ['string', 'null'] } },
    );
    expect(result).toEqual({ val: 'true' });
  });

  // ---- additionalProperties ----
  it('coerces additional properties by additionalProperties schema', () => {
    const result = coerceArgsToSchema(
      { data: { x: '1', y: '2' } },
      {
        data: {
          type: 'object',
          additionalProperties: { type: 'integer' },
        },
      },
    );
    expect(result).toEqual({ data: { x: 1, y: 2 } });
  });

  // ---- Mixed: known + unknown keys ----
  it('coerces known keys and passes through unknown keys', () => {
    const result = coerceArgsToSchema(
      { count: '5', extra: 'hello' },
      { count: { type: 'integer' } },
    );
    expect(result).toEqual({ count: 5, extra: 'hello' });
  });
});

describe.each([
  { mode: 'full', coerce: coerceArgsToSchema, count: 5 },
  { mode: 'container-only', coerce: coerceContainerArgsToSchema, count: '5' },
])('union container recursion ($mode)', ({ coerce, count }) => {
  it.each([
    ['object', 'null'],
    ['string', 'object'],
  ])('recurses into an object with type %j', (...type) => {
    const result = coerce(
      { value: { items: '[1,2]', count: '5', id: 42 } },
      {
        value: {
          type,
          properties: {
            items: { type: 'array', items: { type: 'number' } },
            count: { type: 'number' },
            id: { type: ['string', 'number'] },
          },
        },
      },
    );
    expect(result).toEqual({ value: { items: [1, 2], count, id: 42 } });
  });

  it.each([
    ['array', 'null'],
    ['string', 'array'],
  ])('recurses into an array with type %j', (...type) => {
    const result = coerce(
      { value: ['{"count":"5","id":42}'] },
      {
        value: {
          type,
          items: {
            type: 'object',
            properties: {
              count: { type: 'number' },
              id: { type: ['string', 'number'] },
            },
          },
        },
      },
    );
    expect(result).toEqual({ value: [{ count, id: 42 }] });
  });

  it('recurses into additional properties of a nullable object', () => {
    const result = coerce(
      { value: { extra: '[1,2]' } },
      {
        value: {
          type: ['object', 'null'],
          additionalProperties: { type: 'array', items: { type: 'number' } },
        },
      },
    );
    expect(result).toEqual({ value: { extra: [1, 2] } });
  });

  it('preserves JSON strings when string is an allowed union member', () => {
    const args = { array: '[1,2]', object: '{"n":1}' };
    expect(
      coerce(args, {
        array: { type: ['array', 'string'] },
        object: { type: ['object', 'string'] },
      }),
    ).toEqual(args);
  });
});

describe('coerceContainerArgsToSchema', () => {
  it('parses double-encoded array with surrounding newlines', () => {
    const result = coerceContainerArgsToSchema(
      { items: '\n["a", "b"]\n' },
      { items: { type: 'array', items: { type: 'string' } } },
    );
    expect(result).toEqual({ items: ['a', 'b'] });
  });

  it('does not coerce scalar values', () => {
    const result = coerceContainerArgsToSchema(
      { count: '1abc', enabled: 'true', label: 42 },
      {
        count: { type: 'number' },
        enabled: { type: 'boolean' },
        label: { type: 'string' },
      },
    );
    expect(result).toEqual({
      count: '1abc',
      enabled: 'true',
      label: 42,
    });
  });

  it('recursively parses nested object and array containers without scalar coercion', () => {
    const result = coerceContainerArgsToSchema(
      {
        outer: JSON.stringify({
          items: '["1", "2"]',
          count: '1abc',
        }),
      },
      {
        outer: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'integer' } },
            count: { type: 'number' },
          },
        },
      },
    );

    expect(result).toEqual({
      outer: {
        items: ['1', '2'],
        count: '1abc',
      },
    });
  });
});
