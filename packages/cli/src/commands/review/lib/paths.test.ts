/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tmpFile } from './paths.js';

describe('tmpFile — target is a single safe component', () => {
  it('keeps ordinary labels intact', () => {
    expect(tmpFile('pr-6771', 'diff.txt')).toContain(
      'qwen-review-pr-6771-diff.txt',
    );
    expect(tmpFile('local', 'plan.json')).toContain(
      'qwen-review-local-plan.json',
    );
  });

  it('flattens a file-path target so its parent is not a missing directory', () => {
    // `src/foo.ts` used to make `.qwen/tmp/qwen-review-src/foo.ts-diff.txt`, whose
    // `src/` parent nobody created — ENOENT.
    const p = tmpFile('src/foo.ts', 'diff.txt');
    expect(p).not.toContain('src/foo.ts');
    expect(p).toContain('.qwen/tmp/');
    // No path separator after the temp dir.
    expect(p.split('.qwen/tmp/')[1]).not.toContain('/');
  });

  it('refuses to escape the temp dir with a crafted target', () => {
    const p = tmpFile('../../evil', 'diff.txt');
    expect(p).toContain('.qwen/tmp/');
    expect(p).not.toContain('..');
    expect(p.split('.qwen/tmp/')[1]).not.toContain('/');
  });
});
