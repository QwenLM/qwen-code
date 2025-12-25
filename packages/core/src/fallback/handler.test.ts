/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleFallback } from './handler.js';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';

const createMockConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    isInFallbackMode: vi.fn(() => false),
    setFallbackMode: vi.fn(),
    fallbackHandler: undefined,
    ...overrides,
  }) as unknown as Config;

describe('handleFallback', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = createMockConfig();
  });

  it('should return null for unknown auth types', async () => {
    const result = await handleFallback(
      mockConfig,
      'test-model',
      'unknown-auth',
    );
    expect(result).toBeNull();
  });

  it('should handle Qwen OAuth error', async () => {
    const result = await handleFallback(
      mockConfig,
      'test-model',
      AuthType.QWEN_OAUTH,
      new Error('unauthorized'),
    );
    expect(result).toBeNull();
  });
});
