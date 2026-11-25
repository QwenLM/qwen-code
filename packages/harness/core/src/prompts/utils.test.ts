/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { resolvePathFromEnv } from './utils.js';

vi.mock('../utils/paths.js', () => ({
  homedir: vi.fn().mockReturnValue('/mock/home'),
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: {
    warn: vi.fn(),
  },
}));

describe('resolvePathFromEnv', () => {
  it('should return default values for undefined input', () => {
    const result = resolvePathFromEnv(undefined);
    expect(result).toEqual({
      isSwitch: false,
      value: null,
      isDisabled: false,
    });
  });

  it('should return default values for empty string input', () => {
    const result = resolvePathFromEnv('');
    expect(result).toEqual({
      isSwitch: false,
      value: null,
      isDisabled: false,
    });
  });

  it('should return default values for whitespace-only input', () => {
    const result = resolvePathFromEnv('   ');
    expect(result).toEqual({
      isSwitch: false,
      value: null,
      isDisabled: false,
    });
  });

  it('should recognize "true" as an enabled switch', () => {
    const result = resolvePathFromEnv('true');
    expect(result).toEqual({
      isSwitch: true,
      value: 'true',
      isDisabled: false,
    });
  });

  it('should recognize "1" as an enabled switch', () => {
    const result = resolvePathFromEnv('1');
    expect(result).toEqual({
      isSwitch: true,
      value: '1',
      isDisabled: false,
    });
  });

  it('should recognize "false" as a disabled switch', () => {
    const result = resolvePathFromEnv('false');
    expect(result).toEqual({
      isSwitch: true,
      value: 'false',
      isDisabled: true,
    });
  });

  it('should recognize "0" as a disabled switch', () => {
    const result = resolvePathFromEnv('0');
    expect(result).toEqual({
      isSwitch: true,
      value: '0',
      isDisabled: true,
    });
  });

  it('should handle case-insensitive switch values', () => {
    const result = resolvePathFromEnv('TRUE');
    expect(result).toEqual({
      isSwitch: true,
      value: 'true',
      isDisabled: false,
    });
  });

  it('should handle case-insensitive FALSE', () => {
    const result = resolvePathFromEnv('FALSE');
    expect(result).toEqual({
      isSwitch: true,
      value: 'false',
      isDisabled: true,
    });
  });

  it('should trim whitespace before evaluating switch values', () => {
    const result = resolvePathFromEnv('  true  ');
    expect(result).toEqual({
      isSwitch: true,
      value: 'true',
      isDisabled: false,
    });
  });

  it('should resolve a regular path', () => {
    const p = path.resolve('/some/absolute/path');
    const result = resolvePathFromEnv(p);
    expect(result.isSwitch).toBe(false);
    expect(result.value).toBe(p);
    expect(result.isDisabled).toBe(false);
  });

  it('should resolve a tilde path to the home directory', () => {
    const result = resolvePathFromEnv('~/my/custom/path');
    expect(result.isSwitch).toBe(false);
    expect(result.value).toContain(path.normalize('/mock/home'));
    expect(result.value).toContain(path.normalize('my/custom/path'));
    expect(result.isDisabled).toBe(false);
  });

  it('should resolve a bare tilde to the home directory', () => {
    const result = resolvePathFromEnv('~');
    expect(result.isSwitch).toBe(false);
    expect(result.value).toBe(path.resolve('/mock/home'));
    expect(result.isDisabled).toBe(false);
  });

  it('should handle home directory resolution failure gracefully', async () => {
    const { homedir } = await import('../utils/paths.js');
    vi.mocked(homedir).mockImplementationOnce(() => {
      throw new Error('No home directory');
    });

    const result = resolvePathFromEnv('~/some/path');
    expect(result).toEqual({
      isSwitch: false,
      value: null,
      isDisabled: false,
    });
  });
});
