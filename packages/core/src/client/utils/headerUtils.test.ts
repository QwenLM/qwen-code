/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { setHeaderIfMissing } from './headerUtils.js';

describe('setHeaderIfMissing', () => {
  it('writes a missing header', () => {
    const headers: Record<string, string> = {};
    setHeaderIfMissing(headers, 'X-Client-Version', 'dev');
    expect(headers).toEqual({ 'X-Client-Version': 'dev' });
  });

  it('preserves an existing header regardless of its casing', () => {
    const headers = { 'x-client-version': 'caller-value' };
    setHeaderIfMissing(headers, 'X-Client-Version', 'dev');
    expect(headers).toEqual({ 'x-client-version': 'caller-value' });
  });
});
