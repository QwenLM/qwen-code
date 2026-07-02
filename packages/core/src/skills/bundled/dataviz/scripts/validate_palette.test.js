/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { validatePalette } from './validate_palette.js';

describe('validate_palette', () => {
  it('passes a varied categorical palette on a light chart surface', () => {
    const result = validatePalette(['#2563eb', '#d97706', '#4d7c0f'], {
      mode: 'light',
    });

    expect(result.status).toBe('PASS');
    expect(result.failures).toEqual([]);
  });

  it('passes a varied categorical palette on a dark chart surface', () => {
    const result = validatePalette(['#60a5fa', '#fbbf24'], {
      mode: 'dark',
    });

    expect(result.status).toBe('PASS');
    expect(result.failures).toEqual([]);
  });

  it('fails invalid hex colors', () => {
    const result = validatePalette(['#2563eb', 'blue'], { mode: 'light' });

    expect(result.status).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(/invalid hex/i);
  });

  it('warns when colors are too gray to read as categorical marks', () => {
    const result = validatePalette(['#777777', '#999999'], { mode: 'light' });

    expect(result.status).toBe('WARN');
    expect(result.warnings.join('\n')).toMatch(/chroma/i);
  });

  it('fails low-contrast light marks on a light chart surface', () => {
    const result = validatePalette(['#eeeeee', '#f7f7f7'], { mode: 'light' });

    expect(result.status).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(/contrast/i);
  });

  it('fails low-contrast dark marks on a dark chart surface', () => {
    const result = validatePalette(['#111827', '#1f2937'], { mode: 'dark' });

    expect(result.status).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(/contrast/i);
  });

  it('fails when no colors are provided', () => {
    const result = validatePalette([], { mode: 'light' });

    expect(result.status).toBe('FAIL');
    expect(result.failures).toEqual(['No colors provided.']);
  });

  it('warns when colorblind simulation makes colors too close', () => {
    const result = validatePalette(['#2563eb', '#7c3aed'], { mode: 'light' });

    expect(result.status).toBe('WARN');
    expect(result.warnings.join('\n')).toMatch(/colorblind/i);
  });
});
