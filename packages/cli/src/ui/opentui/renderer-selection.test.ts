/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isOpenTuiRuntimeSupported,
  parseVersion,
  selectTuiRenderer,
} from './renderer-selection.js';

describe('parseVersion', () => {
  it('parses dotted versions', () => {
    expect(parseVersion('1.3.0')).toEqual([1, 3, 0]);
    expect(parseVersion('26.4.0')).toEqual([26, 4, 0]);
  });

  it('tolerates a leading v and pre-release suffixes', () => {
    expect(parseVersion('v1.3.14')).toEqual([1, 3, 14]);
    expect(parseVersion('1.3.0-beta')).toEqual([1, 3, 0]);
  });

  it('stops at the first non-numeric segment', () => {
    expect(parseVersion('2.x')).toEqual([2]);
    expect(parseVersion('')).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('orders versions numerically, not lexically', () => {
    expect(compareVersions('1.3.0', '1.3.0')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.9', '1.3.0')).toBe(-1);
    // Missing segments compare as zero.
    expect(compareVersions('1.3', '1.3.0')).toBe(0);
    expect(compareVersions('26', '26.4.0')).toBe(-1);
  });

  it('sorts a pre-release below its numerically equal release', () => {
    expect(compareVersions('1.3.0-beta', '1.3.0')).toBe(-1);
    expect(compareVersions('1.3.0', '1.3.0-beta')).toBe(1);
    expect(compareVersions('1.3.0-rc.1', '1.3.0-rc.1')).toBe(0);
    // The floor gate therefore rejects a pre-release of the floor itself.
    expect(isOpenTuiRuntimeSupported({ bun: '1.3.0-beta' })).toBe(false);
  });
});

describe('isOpenTuiRuntimeSupported', () => {
  it('accepts Bun at or above the floor', () => {
    expect(isOpenTuiRuntimeSupported({ bun: '1.3.0' })).toBe(true);
    expect(isOpenTuiRuntimeSupported({ bun: '1.3.14' })).toBe(true);
    expect(isOpenTuiRuntimeSupported({ bun: '2.0.0' })).toBe(true);
  });

  it('rejects Bun below the floor', () => {
    expect(isOpenTuiRuntimeSupported({ bun: '1.2.9' })).toBe(false);
    expect(isOpenTuiRuntimeSupported({ bun: '1.0.0' })).toBe(false);
  });

  it('accepts Node at or above the floor', () => {
    expect(isOpenTuiRuntimeSupported({ node: '26.4.0' })).toBe(true);
    expect(isOpenTuiRuntimeSupported({ node: '27.0.0' })).toBe(true);
  });

  it('rejects Node below the floor, including the project minimum', () => {
    expect(isOpenTuiRuntimeSupported({ node: '24.15.0' })).toBe(false);
    expect(isOpenTuiRuntimeSupported({ node: '22.0.0' })).toBe(false);
    expect(isOpenTuiRuntimeSupported({ node: '26.3.9' })).toBe(false);
  });

  it('prefers the Bun version when both are reported', () => {
    expect(isOpenTuiRuntimeSupported({ bun: '1.3.0', node: '22.0.0' })).toBe(
      true,
    );
    expect(isOpenTuiRuntimeSupported({ bun: '1.0.0', node: '27.0.0' })).toBe(
      false,
    );
  });

  it('rejects an unknown runtime', () => {
    expect(isOpenTuiRuntimeSupported({})).toBe(false);
  });
});

describe('selectTuiRenderer', () => {
  const supported = { bun: '1.3.14' };
  const unsupported = { node: '24.15.0' };

  it('defaults to ink when the flag is unset or empty', () => {
    expect(selectTuiRenderer(undefined, supported).renderer).toBe('ink');
    expect(selectTuiRenderer('', supported).renderer).toBe('ink');
    expect(selectTuiRenderer('   ', supported).renderer).toBe('ink');
  });

  it('selects opentui only for the exact value (case-insensitive)', () => {
    expect(selectTuiRenderer('opentui', supported).renderer).toBe('opentui');
    expect(selectTuiRenderer('OpenTUI', supported).renderer).toBe('opentui');
    expect(selectTuiRenderer(' opentui ', supported).renderer).toBe('opentui');
    expect(selectTuiRenderer('ink', supported).renderer).toBe('ink');
    expect(selectTuiRenderer('bogus', supported).renderer).toBe('ink');
  });

  it('falls back to ink when the runtime is unsupported', () => {
    const selection = selectTuiRenderer('opentui', unsupported);
    expect(selection.renderer).toBe('ink');
    expect(selection.reason).toContain('native FFI');
  });

  it('keeps ink when the flag explicitly asks for ink', () => {
    expect(selectTuiRenderer('ink', supported).renderer).toBe('ink');
  });
});
