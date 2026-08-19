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

  it('keeps dashes — artifact naming is a two-sided contract', () => {
    // Review producers hardcode the dash spelling (bundled-skill templates,
    // composed names, prev-ledger); the lift must not rename any slug.
    expect(safeTarget('pr-6771')).toBe('pr-6771');
    expect(safeTarget('foo-bar')).toBe('foo-bar');
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

  it('strips leading dots and underscores (byte-identical to the pre-lift behavior)', () => {
    expect(safeTarget('./--verbose')).toBe('--verbose');
    expect(safeTarget('_foo')).toBe('foo');
    expect(safeTarget('...foo')).toBe('foo');
    // Dashes are NOT leading-stripped — matching the pre-lift implementation
    // exactly is the lift's contract.
    expect(safeTarget('-foo')).toBe('-foo');
  });

  it('falls back to "target" when nothing safe remains', () => {
    expect(safeTarget('')).toBe('target');
    expect(safeTarget('.')).toBe('target');
    expect(safeTarget('...')).toBe('target');
    expect(safeTarget('///')).toBe('target');
  });
});
