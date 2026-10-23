/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isBranchName } from './state.js';

describe('isBranchName', () => {
  it('accepts what git accepts as a branch name', () => {
    for (const name of ['feat', 'feat/x-1', 'user/fix_2', 'v1.2']) {
      expect(isBranchName(name)).toBe(true);
    }
  });

  it('refuses refspec syntax, options and what git refuses', () => {
    for (const name of [
      'feat:refs/heads/release',
      'refs/heads/*',
      '-x',
      'a..b',
      'a@{1}',
      '@',
      'a//b',
      'a/',
      'a.',
      '.a',
      'a/.b',
      'a.lock',
      'a b',
      'a\\b',
      'a~1',
      'a^',
      'a?',
      'a[1]',
      'a\u0001',
    ]) {
      expect({ name, ok: isBranchName(name) }).toEqual({ name, ok: false });
    }
  });
});
