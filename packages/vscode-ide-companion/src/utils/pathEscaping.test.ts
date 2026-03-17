/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { escapePath, unescapePath } from './pathEscaping.js';

describe('pathEscaping', () => {
  it('round-trips shell-escaped file paths', () => {
    const originalPath = '/tmp/My Images/(draft) final.png';

    expect(unescapePath(escapePath(originalPath))).toBe(originalPath);
  });
});
