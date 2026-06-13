/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeBridgeHints } from './hints.js';

describe('computeBridgeHints', () => {
  it('renderable for small, clean args', () => {
    expect(
      computeBridgeHints({ name: 'read_file', args: { path: 'src/app.ts' } }),
    ).toEqual({ renderable: true });
  });

  it('flags possible secrets (key or value) → not renderable', () => {
    expect(computeBridgeHints({ args: { apiKey: 'sk-12345' } }).reason).toBe(
      'possible_secret',
    );
    expect(
      computeBridgeHints({ args: { env: 'AUTHORIZATION=Bearer x' } }).reason,
    ).toBe('possible_secret');
    expect(
      computeBridgeHints({ args: { password: 'hunter2' } }).renderable,
    ).toBe(false);
  });

  it('flags oversized args → too_large', () => {
    const big = { args: { blob: 'x'.repeat(5000) } };
    expect(computeBridgeHints(big)).toEqual({
      renderable: false,
      reason: 'too_large',
    });
  });

  it('inspects the whole call when there is no args sub-object', () => {
    expect(computeBridgeHints({ secret: 'abc' }).reason).toBe(
      'possible_secret',
    );
  });

  it('is total for odd inputs (null/undefined/primitive)', () => {
    expect(computeBridgeHints(null)).toEqual({ renderable: true });
    expect(computeBridgeHints(undefined)).toEqual({ renderable: true });
    expect(computeBridgeHints(42)).toEqual({ renderable: true });
  });

  it('degrades a circular (unserializable) arg to not-renderable', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(computeBridgeHints({ args: circular }).renderable).toBe(false);
  });
});
