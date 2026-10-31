/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isUpdateMode,
  normalizeUpdateModeInPlace,
  resolveUpdateMode,
  UPDATE_MODES,
} from './update-mode.js';

describe('resolveUpdateMode', () => {
  it('defaults to auto when nothing is set', () => {
    expect(resolveUpdateMode(undefined)).toBe('auto');
    expect(resolveUpdateMode({})).toBe('auto');
  });

  it('maps legacy enableAutoUpdate false to off', () => {
    expect(resolveUpdateMode({ enableAutoUpdate: false })).toBe('off');
  });

  it('maps legacy enableAutoUpdate true to auto', () => {
    expect(resolveUpdateMode({ enableAutoUpdate: true })).toBe('auto');
  });

  it('treats non-boolean legacy values as enabled, like the old !== false gate', () => {
    expect(resolveUpdateMode({ enableAutoUpdate: 'false' })).toBe('auto');
    expect(resolveUpdateMode({ enableAutoUpdate: 0 })).toBe('auto');
    expect(resolveUpdateMode({ enableAutoUpdate: null })).toBe('auto');
  });

  it('honors an explicit valid updateMode over the legacy key', () => {
    expect(
      resolveUpdateMode({ updateMode: 'notify', enableAutoUpdate: false }),
    ).toBe('notify');
    expect(
      resolveUpdateMode({ updateMode: 'off', enableAutoUpdate: true }),
    ).toBe('off');
  });

  it('falls back to the legacy key when updateMode is invalid', () => {
    expect(
      resolveUpdateMode({ updateMode: 'silent', enableAutoUpdate: false }),
    ).toBe('off');
    expect(
      resolveUpdateMode({ updateMode: 3, enableAutoUpdate: true }),
    ).toBe('auto');
  });

  it('falls back to auto when updateMode is invalid and no legacy key exists', () => {
    expect(resolveUpdateMode({ updateMode: 'sometimes' })).toBe('auto');
  });
});

describe('isUpdateMode', () => {
  it('accepts the three documented modes', () => {
    expect(UPDATE_MODES).toEqual(['auto', 'notify', 'off']);
    for (const mode of UPDATE_MODES) {
      expect(isUpdateMode(mode)).toBe(true);
    }
  });

  it('rejects other values', () => {
    expect(isUpdateMode('silent')).toBe(false);
    expect(isUpdateMode('')).toBe(false);
    expect(isUpdateMode(undefined)).toBe(false);
    expect(isUpdateMode(null)).toBe(false);
    expect(isUpdateMode(1)).toBe(false);
  });
});

describe('normalizeUpdateModeInPlace', () => {
  it('derives off from a legacy-only scope', () => {
    const settings: {
      general?: { updateMode?: unknown; enableAutoUpdate?: boolean };
    } = { general: { enableAutoUpdate: false } };
    normalizeUpdateModeInPlace(settings);
    expect(settings.general?.updateMode).toBe('off');
  });

  it('derives auto from a legacy-enabled scope', () => {
    const settings: {
      general?: { updateMode?: unknown; enableAutoUpdate?: boolean };
    } = { general: { enableAutoUpdate: true } };
    normalizeUpdateModeInPlace(settings);
    expect(settings.general?.updateMode).toBe('auto');
  });

  it('leaves valid explicit values untouched', () => {
    const settings = { general: { updateMode: 'notify' } };
    normalizeUpdateModeInPlace(settings);
    expect(settings.general?.updateMode).toBe('notify');
  });

  it('corrects an invalid value in place', () => {
    const settings = { general: { updateMode: 'nope', enableAutoUpdate: false } };
    normalizeUpdateModeInPlace(settings);
    expect(settings.general?.updateMode).toBe('off');
  });

  it('leaves scopes that set neither key untouched', () => {
    const settings: { general?: { updateMode?: unknown } } = { general: {} };
    normalizeUpdateModeInPlace(settings);
    expect(settings.general?.updateMode).toBeUndefined();
    expect('updateMode' in (settings.general ?? {})).toBe(false);
  });

  it('handles missing or null settings objects', () => {
    expect(() => normalizeUpdateModeInPlace(undefined)).not.toThrow();
    expect(() => normalizeUpdateModeInPlace(null)).not.toThrow();
    const settings: { general?: { updateMode?: unknown } } = {};
    normalizeUpdateModeInPlace(settings);
    expect(settings.general).toBeUndefined();
  });
});
