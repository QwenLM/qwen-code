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
    // Deep nested paths flatten past POSIX's 255-byte filename component cap
    // (ENAMETOOLONG): truncate and carry a hash of the ORIGINAL target so
    // distinct deep paths stay distinct. The fixtures share a flattened
    // prefix longer than the kept window (≥187 chars) and differ only in the
    // tail, so a truncation-only slug — one that dropped the digest — would
    // collide here instead of shipping green.
    const shared = Array.from({ length: 30 }, (_, i) => `level${i}`).join('/');
    const deepA = `${shared}/alpha`;
    const deepB = `${shared}/beta`;
    const slugA = safeTarget(deepA);
    const slugB = safeTarget(deepB);
    expect(slugA.length).toBeLessThanOrEqual(200);
    expect(slugB.length).toBeLessThanOrEqual(200);
    expect(slugA).not.toBe(slugB);
    // …and the digest hashes the ORIGINAL target, not its flattened form:
    // these two flatten to the same string, so only a hash of the originals
    // keeps them apart (a hash-of-`flat` mutant collides).
    const flatA = 'a/' + 'b/'.repeat(100) + 'end';
    const flatB = flatA.replaceAll('/', '_');
    expect(safeTarget(flatA)).not.toBe(safeTarget(flatB));
    // Deterministic: the same target always flattens to the same slug.
    expect(safeTarget(deepA)).toBe(slugA);
    // Shallow targets stay untouched.
    expect(safeTarget('packages/core')).toBe('packages_core');
  });
});
