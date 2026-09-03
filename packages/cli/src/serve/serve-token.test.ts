/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { resolveServeToken } from './serve-token.js';

describe('resolveServeToken', () => {
  it('prefers and trims the CLI option', () => {
    expect(resolveServeToken('  from-option  ', 'from-env')).toBe(
      'from-option',
    );
  });

  it('trims the environment fallback', () => {
    expect(resolveServeToken(undefined, '  from-env\n')).toBe('from-env');
  });

  it('keeps an explicitly empty option ahead of the environment', () => {
    expect(resolveServeToken('', 'from-env')).toBeUndefined();
    expect(resolveServeToken('   ', 'from-env')).toBeUndefined();
  });
});
