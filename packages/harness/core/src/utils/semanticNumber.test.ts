/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { semanticNumber } from './semanticNumber.js';

describe('semanticNumber', () => {
  const schema = z.object({ count: semanticNumber() });

  it('accepts a number', () => {
    expect(schema.parse({ count: 42 })).toEqual({ count: 42 });
  });

  it('coerces integer string', () => {
    expect(schema.parse({ count: '42' })).toEqual({ count: 42 });
  });

  it('coerces negative integer string', () => {
    expect(schema.parse({ count: '-5' })).toEqual({ count: -5 });
  });

  it('coerces float string', () => {
    expect(schema.parse({ count: '3.14' })).toEqual({ count: 3.14 });
  });

  it('rejects non-numeric strings', () => {
    expect(() => schema.parse({ count: 'abc' })).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => schema.parse({ count: '' })).toThrow();
  });

  it('rejects boolean', () => {
    expect(() => schema.parse({ count: true })).toThrow();
  });

  it('works with optional()', () => {
    const optSchema = z.object({
      count: semanticNumber(z.number().optional()),
    });
    expect(optSchema.parse({ count: undefined })).toEqual({
      count: undefined,
    });
    expect(optSchema.parse({ count: '10' })).toEqual({ count: 10 });
    expect(optSchema.parse({})).toEqual({});
  });

  it('works with default()', () => {
    const defSchema = z.object({
      count: semanticNumber(z.number().default(0)),
    });
    expect(defSchema.parse({})).toEqual({ count: 0 });
    expect(defSchema.parse({ count: '99' })).toEqual({ count: 99 });
  });
});
