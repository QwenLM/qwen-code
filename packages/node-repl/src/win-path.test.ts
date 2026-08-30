/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  mergeWindowsPathValues,
  normalizePathEnvForWindows,
} from './win-path.js';

const realPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

afterEach(() => {
  setPlatform(realPlatform);
});

// `normalizePathEnvForWindows` is a no-op off win32, so the platform-independent
// contract is exercised through `mergeWindowsPathValues`, which holds the actual
// merge/dedup/order logic.
describe('mergeWindowsPathValues', () => {
  it('returns undefined when no key is present', () => {
    expect(mergeWindowsPathValues({}, ['PATH', 'Path'])).toBeUndefined();
  });

  it('merges case-variant keys in the given key order', () => {
    expect(
      mergeWindowsPathValues({ PATH: 'a;b', Path: 'c' }, ['PATH', 'Path']),
    ).toBe('a;b;c');
  });

  it('deduplicates entries while preserving first-seen order', () => {
    expect(
      mergeWindowsPathValues({ PATH: 'a;b', Path: 'b;c;a', path: 'd' }, [
        'PATH',
        'Path',
        'path',
      ]),
    ).toBe('a;b;c;d');
  });

  it('skips undefined values but keeps the rest', () => {
    expect(mergeWindowsPathValues({ Path: 'x' }, ['PATH', 'Path'])).toBe('x');
  });

  it('preserves empty-string entries as distinct once', () => {
    // 'a;;b' contains an empty entry between the two delimiters.
    expect(mergeWindowsPathValues({ PATH: 'a;;b;;c' }, ['PATH'])).toBe(
      'a;;b;c',
    );
  });
});

describe('normalizePathEnvForWindows', () => {
  it('is a no-op off win32', () => {
    setPlatform('linux');
    const env = { PATH: 'a', Path: 'b' };
    expect(normalizePathEnvForWindows(env)).toBe(env);
  });

  it('collapses case-variant PATH keys into a single canonical PATH', () => {
    setPlatform('win32');
    // Unique values so the memo cannot mask a broken merge.
    const result = normalizePathEnvForWindows({
      Path: 'p1;shared',
      PATH: 'p2',
      path: 'p3;shared',
      OTHER: 'keep',
    });
    // PATH is ordered first, then the remaining variants; duplicates dropped.
    expect(result['PATH']).toBe('p2;p1;shared;p3');
    expect(result['Path']).toBeUndefined();
    expect(result['path']).toBeUndefined();
    expect(result['OTHER']).toBe('keep');
  });

  it('returns a copy and leaves the input env untouched', () => {
    setPlatform('win32');
    const env = { Path: 'x', KEEP: '1' };
    const result = normalizePathEnvForWindows(env);
    expect(result).not.toBe(env);
    expect(env['Path']).toBe('x');
    expect(result['PATH']).toBe('x');
  });

  it('handles an env with no PATH-like key', () => {
    setPlatform('win32');
    const result = normalizePathEnvForWindows({ HOME: '/h' });
    expect(result['PATH']).toBeUndefined();
    expect(result['HOME']).toBe('/h');
  });

  it('recomputes when the PATH values change (memo is keyed correctly)', () => {
    setPlatform('win32');
    expect(normalizePathEnvForWindows({ PATH: 'first' })['PATH']).toBe('first');
    expect(normalizePathEnvForWindows({ PATH: 'second' })['PATH']).toBe(
      'second',
    );
    expect(normalizePathEnvForWindows({ PATH: 'first' })['PATH']).toBe('first');
  });
});
