/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isBunVirtualPath } from './bundledMode.js';

describe('bundledMode', () => {
  it('recognizes Bun compiled virtual entry paths', () => {
    expect(isBunVirtualPath('/$bunfs/root/index.js')).toBe(true);
    expect(isBunVirtualPath('/usr/local/lib/qwen/index.js')).toBe(false);
    expect(isBunVirtualPath(undefined)).toBe(false);
  });
});
