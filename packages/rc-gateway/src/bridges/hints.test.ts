/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeBridgeHints } from './hints.js';

describe('computeBridgeHints (bridge-protocol contract shape)', () => {
  it('emits all four contract fields', () => {
    const h = computeBridgeHints({ name: 'read_file', args: { path: 'a.ts' } });
    expect(Object.keys(h).sort()).toEqual(
      [
        'argsSummaryFull',
        'argsSummaryShort',
        'recommendedSurface',
        'sensitivity',
      ].sort(),
    );
  });

  it('clean read-only call → low sensitivity, inline', () => {
    const h = computeBridgeHints({ name: 'read_file', args: { path: 'a.ts' } });
    expect(h.sensitivity).toBe('low');
    expect(h.recommendedSurface).toBe('inline');
    expect(h.argsSummaryShort).toContain('read_file');
    expect(h.argsSummaryFull).toContain('a.ts');
  });

  it('mutating tool → medium sensitivity, still inline (review in chat)', () => {
    const h = computeBridgeHints({
      name: 'edit_file',
      args: { path: 'a.ts' },
    });
    expect(h.sensitivity).toBe('medium');
    expect(h.recommendedSurface).toBe('inline');
  });

  it('secret-looking args → high sensitivity, deeplink, redacted summary', () => {
    const h = computeBridgeHints({ name: 'set_env', args: { apiKey: 'sk-x' } });
    expect(h.sensitivity).toBe('high');
    expect(h.recommendedSurface).toBe('deeplink');
    // The short summary must NOT echo the secret.
    expect(h.argsSummaryShort).not.toContain('sk-x');
    expect(h.argsSummaryShort).toContain('hidden');
  });

  it('oversized args → deeplink, full summary capped', () => {
    const h = computeBridgeHints({
      name: 'read_file',
      args: { blob: 'x'.repeat(5000) },
    });
    expect(h.recommendedSurface).toBe('deeplink');
    expect(h.argsSummaryFull.length).toBeLessThan(5000);
    expect(h.argsSummaryFull).toContain('truncated');
  });

  it('short summary is capped at 140 chars', () => {
    const h = computeBridgeHints({
      name: 'read_file',
      args: { path: 'y'.repeat(500) },
    });
    expect(h.argsSummaryShort.length).toBeLessThanOrEqual(140);
  });

  it('is total for odd inputs and degrades unserializable args to a safe deeplink', () => {
    expect(computeBridgeHints(null).recommendedSurface).toBe('inline');
    expect(computeBridgeHints(42).sensitivity).toBe('low');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const h = computeBridgeHints({ name: 'x', args: circular });
    expect(h.recommendedSurface).toBe('deeplink');
    expect(h.sensitivity).toBe('high');
  });
});
