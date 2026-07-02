/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/* global process */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validatePalette } from './validate_palette.js';

const scriptPath = fileURLToPath(import.meta.url).replace(/\.test\.js$/, '.js');

describe('validate_palette', () => {
  it('passes a varied categorical palette on a light chart surface', () => {
    const result = validatePalette(['#1d4ed8', '#b45309', '#166534'], {
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

  it('fails marks outside the OKLCH lightness band', () => {
    const result = validatePalette(['#1a1a2e'], { mode: 'light' });

    expect(result.status).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(/lightness/i);
  });

  it('fails when no colors are provided', () => {
    const result = validatePalette([], { mode: 'light' });

    expect(result.status).toBe('FAIL');
    expect(result.failures).toEqual(['No colors provided.']);
  });

  it('fails unsupported modes without reading object prototypes', () => {
    const result = validatePalette(['#2563eb'], { mode: '__proto__' });

    expect(result.status).toBe('FAIL');
    expect(result.failures.join('\n')).toMatch(/unsupported mode/i);
  });

  it('warns when colorblind simulation makes colors too close', () => {
    const result = validatePalette(['#2563eb', '#7c3aed'], { mode: 'light' });

    expect(result.status).toBe('WARN');
    expect(result.warnings.join('\n')).toMatch(/colorblind/i);
  });

  it('warns when simulated colors lose chart-surface contrast', () => {
    const result = validatePalette(['#d97706'], { mode: 'light' });

    expect(result.status).toBe('WARN');
    expect(result.warnings.join('\n')).toMatch(/contrast/i);
  });

  it('accepts --mode before the palette in CLI usage', () => {
    const output = execFileSync(process.execPath, [
      scriptPath,
      '--mode',
      'dark',
      '#60a5fa,#fbbf24',
    ]).toString();

    expect(output).toMatch(/^PASS$/m);
  });

  it('accepts --mode=value in CLI usage', () => {
    const output = execFileSync(process.execPath, [
      scriptPath,
      '--mode=dark',
      '#60a5fa,#fbbf24',
    ]).toString();

    expect(output).toMatch(/^PASS$/m);
  });

  it('rejects --mode without a value in CLI usage', () => {
    expect(() =>
      execFileSync(process.execPath, [scriptPath, '#2563eb', '--mode'], {
        stdio: 'pipe',
      }),
    ).toThrow();
  });

  it('treats invalid CLI modes as usage errors', () => {
    try {
      execFileSync(process.execPath, [
        scriptPath,
        '--mode',
        'midnight',
        '#2563eb',
      ]);
      throw new Error('expected command to fail');
    } catch (err) {
      expect(err.status).toBe(2);
      expect(err.stderr.toString()).toMatch(/unsupported mode/i);
    }
  });

  it('prints validation failure details to stderr', () => {
    try {
      execFileSync(process.execPath, [scriptPath, '#eeeeee'], {
        stdio: 'pipe',
      });
      throw new Error('expected command to fail');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stdout.toString()).toMatch(/^FAIL$/m);
      expect(err.stderr.toString()).toMatch(/FAIL:/);
    }
  });
});
