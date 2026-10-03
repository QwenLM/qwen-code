/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { relativizeGlobText } from './managed-runtime-tool-executor.js';

// The route-level fixtures cannot express these geometries (a Session root is
// always a deep unique tmpdir path), so the anchoring invariants are pinned
// against the function directly.
describe('relativizeGlobText', () => {
  it('strips the root at token starts but keeps a tail that repeats it', () => {
    // The hit carries the root string twice: once as the path prefix and once
    // as a real directory tail ('backup/srv/api' — a directory named srv
    // holding a file named api). Eating the tail is the corruption the
    // leading boundary exists to prevent.
    const text =
      'Found 1 file(s) matching "**/*" within /srv/api\n---\n/srv/api/backup/srv/api';
    expect(relativizeGlobText(text, '/srv/api')).toBe(
      'Found 1 file(s) matching "**/*" within .\n---\nbackup/srv/api',
    );
  });

  it('does not fuse a nested directory whose name repeats the root tail', () => {
    // The R2-1 shape: '/app/src/app/component.ts' must become
    // 'src/app/component.ts', never 'srccomponent.ts'.
    const text = '/app/src/app/component.ts';
    expect(relativizeGlobText(text, '/app')).toBe('src/app/component.ts');
  });

  it('keeps the echoed pattern verbatim for a root of /', () => {
    // The degenerate root is both the boundary and every path's prefix: the
    // rewrite must stand down rather than eat the pattern's separators.
    const text =
      'Found 3 file(s) matching "etc*/host*" within /\n---\netc/hosts\netc/hostname';
    expect(relativizeGlobText(text, '/')).toBe(text);
  });
});
