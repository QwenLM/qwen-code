/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isImageGenerationCapable } from './image-generation-capability.js';

describe('isImageGenerationCapable', () => {
  it.each([
    [false, {}],
    [false, { supportsImageGeneration: false }],
    [true, { supportsImageGeneration: true }],
    [true, { imageOnly: true }],
    [true, { supportsImageGeneration: true, imageOnly: true }],
    [true, { supportsImageGeneration: false, imageOnly: true }],
  ] as const)('returns %s for %o', (expected, model) => {
    expect(isImageGenerationCapable(model)).toBe(expected);
  });
});
