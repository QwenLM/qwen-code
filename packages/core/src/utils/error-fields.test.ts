/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getStackTop } from './error-fields.js';

describe('error-fields', () => {
  it('returns the first stack frame instead of the error message line', () => {
    const stack = [
      'TypeError: terminated',
      '    at Fetch.onAborted (node:internal/deps/undici/undici:11132:53)',
      '    at Fetch.emit (node:events:518:28)',
    ].join('\n');

    expect(getStackTop(stack)).toBe(
      'at Fetch.onAborted (node:internal/deps/undici/undici:11132:53)',
    );
  });

  it('returns undefined when no stack frame is present', () => {
    expect(getStackTop('TypeError: terminated')).toBeUndefined();
  });
});
