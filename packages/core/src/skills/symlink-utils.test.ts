/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { isResolvedPathInsideBase } from './symlink-utils.js';

describe('symlink-utils', () => {
  describe('isResolvedPathInsideBase', () => {
    it('accepts a target inside the base directory', () => {
      expect(
        isResolvedPathInsideBase(
          '/repo/.qwen/skills/react',
          '/repo/.qwen/skills',
          path.posix,
        ),
      ).toBe(true);
    });

    it('rejects sibling prefixes outside the base directory', () => {
      expect(
        isResolvedPathInsideBase(
          '/repo/.qwen/skills-malicious/react',
          '/repo/.qwen/skills',
          path.posix,
        ),
      ).toBe(false);
    });

    it('rejects Windows cross-drive targets', () => {
      expect(
        isResolvedPathInsideBase(
          'D:\\payload\\skill',
          'C:\\repo\\.qwen\\skills',
          path.win32,
        ),
      ).toBe(false);
    });

    it('handles Windows separator and case differences', () => {
      expect(
        isResolvedPathInsideBase(
          'c:\\repo\\.qwen\\skills\\React',
          'C:\\Repo\\.qwen\\skills',
          path.win32,
        ),
      ).toBe(true);
    });
  });
});
