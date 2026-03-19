/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getErrorMessage } from './errorMessage.js';

describe('getErrorMessage', () => {
  it('extracts detailed message from top-level data.details string', () => {
    expect(
      getErrorMessage({
        data: {
          details: 'Detailed error from backend',
        },
      }),
    ).toBe('Detailed error from backend');
  });

  it('extracts detailed message from nested error.data.details.message', () => {
    expect(
      getErrorMessage({
        error: {
          data: {
            details: {
              message: 'Nested detailed error message',
            },
          },
        },
      }),
    ).toBe('Nested detailed error message');
  });
});
