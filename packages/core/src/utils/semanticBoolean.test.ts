/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { semanticBoolean } from './semanticBoolean.js';

describe('semanticBoolean', () => {
  const schema = z.object({ flag: semanticBoolean() });

  it('accepts true boolean', () => {
    expect(schema.parse({ flag: true })).toEqual({ flag: true });
  });

  it('accepts false boolean', () => {
    expect(schema.parse({ flag: false })).toEqual({ flag: false });
  });

  it('coerces "true" string to true', () => {
    expect(schema.parse({ flag: 'true' })).toEqual({ flag: true });
  });

  it('coerces "false" string to false', () => {
    expect(schema.parse({ flag: 'false' })).toEqual({ flag: false });
  });

  it('rejects other strings', () => {
    expect(() => schema.parse({ flag: 'yes' })).toThrow();
  });

  it('rejects numbers', () => {
    expect(() => schema.parse({ flag: 1 })).toThrow();
  });

  it('works with optional()', () => {
    const optSchema = z.object({
      flag: semanticBoolean(z.boolean().optional()),
    });
    expect(optSchema.parse({ flag: undefined })).toEqual({ flag: undefined });
    expect(optSchema.parse({ flag: 'true' })).toEqual({ flag: true });
    expect(optSchema.parse({})).toEqual({});
  });

  it('works with default()', () => {
    const defSchema = z.object({
      flag: semanticBoolean(z.boolean().default(false)),
    });
    expect(defSchema.parse({})).toEqual({ flag: false });
    expect(defSchema.parse({ flag: 'true' })).toEqual({ flag: true });
  });
});
