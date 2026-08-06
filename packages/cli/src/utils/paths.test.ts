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

  it('falls back to "target" when nothing safe remains', () => {
    expect(safeTarget('')).toBe('target');
    expect(safeTarget('.')).toBe('target');
    expect(safeTarget('...')).toBe('target');
    expect(safeTarget('///')).toBe('target');
  });
});
