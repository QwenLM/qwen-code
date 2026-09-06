/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEOUT,
  DISABLED_REQUEST_TIMEOUT_MS,
  resolveRequestTimeout,
} from './constants.js';

describe('resolveRequestTimeout', () => {
  it('returns DEFAULT_TIMEOUT when timeout is undefined', () => {
    expect(resolveRequestTimeout(undefined)).toBe(DEFAULT_TIMEOUT);
  });

  it('returns DEFAULT_TIMEOUT when timeout is null', () => {
    expect(resolveRequestTimeout(null)).toBe(DEFAULT_TIMEOUT);
  });

  it('maps 0 to the disabled sentinel', () => {
    expect(resolveRequestTimeout(0)).toBe(DISABLED_REQUEST_TIMEOUT_MS);
  });

  it('maps negative values to the disabled sentinel', () => {
    expect(resolveRequestTimeout(-5)).toBe(DISABLED_REQUEST_TIMEOUT_MS);
  });

  it('passes a positive value through unchanged', () => {
    expect(resolveRequestTimeout(60000)).toBe(60000);
  });
});
