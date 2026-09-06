/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { isOpenRouterHostname } from './openrouter.js';

describe('isOpenRouterHostname', () => {
  it.each([
    ['https://openrouter.ai/api/v1', true],
    ['https://eu.openrouter.ai/api/v1', true],
    ['https://openrouter.ai.evil.com/v1', false],
    ['https://evilopenrouter.ai/v1', false],
    ['not a url', false],
    ['', false],
  ])('classifies %s as %s', (baseUrl, expected) => {
    expect(isOpenRouterHostname({ baseUrl } as ContentGeneratorConfig)).toBe(
      expected,
    );
  });
});
