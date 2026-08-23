/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveServeToken } from './serve-token.js';

describe('resolveServeToken', () => {
  it('prefers and trims the CLI option', () => {
    expect(
      resolveServeToken('  from-option  ', {
        QWEN_SERVER_TOKEN: 'from-env',
      }),
    ).toBe('from-option');
  });

  it('trims the environment fallback', () => {
    expect(
      resolveServeToken(undefined, { QWEN_SERVER_TOKEN: '  from-env\n' }),
    ).toBe('from-env');
  });

  it('keeps an explicitly empty option ahead of the environment', () => {
    expect(
      resolveServeToken('   ', { QWEN_SERVER_TOKEN: 'from-env' }),
    ).toBeUndefined();
  });
});
