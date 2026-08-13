/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { safeTarget } from './paths.js';

describe('safeTarget', () => {
  it('flattens separators but preserves dotted slugs', () => {
    expect(safeTarget('src/foo.ts')).toBe('src_foo.ts');
    expect(safeTarget('packages/core')).toBe('packages_core');
    expect(safeTarget('archive.tar.gz')).toBe('archive.tar.gz');
  });

  it('neutralizes traversal tokens', () => {
    expect(safeTarget('../../evil')).toBe('evil');
    expect(safeTarget('..\\..\\evil')).toBe('evil');
    expect(safeTarget('foo..bar')).toBe('foo_bar');
  });

  it('maps odd characters to underscores', () => {
    expect(safeTarget('C:/tmp/x')).toBe('C__tmp_x');
    expect(safeTarget('a b:c')).toBe('a_b_c');
  });

  it('strips leading dashes so slugs survive argv boundaries', () => {
    expect(safeTarget('-foo')).toBe('foo');
    expect(safeTarget('./--verbose')).toBe('verbose');
    expect(safeTarget('---')).toBe('target');
  });

  it('falls back to "target" when nothing safe remains', () => {
    expect(safeTarget('')).toBe('target');
    expect(safeTarget('.')).toBe('target');
    expect(safeTarget('...')).toBe('target');
    expect(safeTarget('///')).toBe('target');
  });

  it('bounds deep targets to the one-component cap, keeping them distinct', () => {
    // A 30-level nested path flattens past POSIX's 255-byte filename
    // component cap (ENAMETOOLONG): truncate and carry a hash of the
    // ORIGINAL target so distinct deep paths stay distinct.
    const deepA = Array.from({ length: 30 }, (_, i) => `level${i}`).join('/');
    const deepB = Array.from({ length: 30 }, (_, i) => `layer${i}`).join('/');
    const slugA = safeTarget(deepA);
    const slugB = safeTarget(deepB);
    expect(slugA.length).toBeLessThanOrEqual(200);
    expect(slugB.length).toBeLessThanOrEqual(200);
    expect(slugA).not.toBe(slugB);
    // Deterministic: the same target always flattens to the same slug.
    expect(safeTarget(deepA)).toBe(slugA);
    // Shallow targets stay untouched.
    expect(safeTarget('packages/core')).toBe('packages_core');
  });
});
