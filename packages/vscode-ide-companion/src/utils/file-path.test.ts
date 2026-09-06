/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { shouldResolveAgainstWorkspace } from './file-path.js';

describe('shouldResolveAgainstWorkspace', () => {
  it('returns true for relative paths', () => {
    expect(shouldResolveAgainstWorkspace('src/app.ts')).toBe(true);
    expect(shouldResolveAgainstWorkspace('nested/folder/file.ts')).toBe(true);
  });

  it('returns false for POSIX absolute paths', () => {
    expect(shouldResolveAgainstWorkspace('/workspace/src/app.ts')).toBe(false);
  });

  it('returns false for Windows drive-letter paths', () => {
    expect(shouldResolveAgainstWorkspace('C:\\workspace\\src\\app.ts')).toBe(
      false,
    );
    expect(shouldResolveAgainstWorkspace('C:/workspace/src/app.ts')).toBe(
      false,
    );
  });

  it('returns false for Windows UNC paths', () => {
    expect(shouldResolveAgainstWorkspace('\\\\server\\share\\app.ts')).toBe(
      false,
    );
  });
});
