/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_MODEL_MAX_ATTEMPTS,
  DEFAULT_CHAT_MODEL_MAX_RETRIES,
  normalizeMaxAttempts,
} from './modelRequestConfig.js';

describe('model request attempt configuration', () => {
  it('allows four retries by default', () => {
    expect(DEFAULT_CHAT_MODEL_MAX_RETRIES).toBe(4);
    expect(DEFAULT_CHAT_MODEL_MAX_ATTEMPTS).toBe(5);
  });

  it('does not impose a product-level maximum', () => {
    expect(normalizeMaxAttempts(20)).toBe(20);
    expect(normalizeMaxAttempts(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
