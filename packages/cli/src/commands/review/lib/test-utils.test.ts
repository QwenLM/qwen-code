/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { gitConfigPath } from './test-utils.js';

describe('gitConfigPath', () => {
  // `gitConfigPath` exists for Windows: `join()` builds backslash paths
  // there, and git's config lexer rejects them inside hand-written config
  // text (`fatal: bad config line`, measured on git 2.47.3). On POSIX the
  // separator IS the forward slash, so the transform is pinned here with
  // the Windows separator named explicitly.
  it('forward-slashes backslash paths — the spelling git config parses on every platform', () => {
    expect(gitConfigPath('C:\\a\\_temp\\behind.config', '\\')).toBe(
      'C:/a/_temp/behind.config',
    );
  });
});
