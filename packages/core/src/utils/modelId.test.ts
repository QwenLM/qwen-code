/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import { resolveModelId } from './modelId.js';

describe('resolveModelId', () => {
  it('drops the "\0<baseUrl>" endpoint disambiguator from persisted selectors', () => {
    // The model picker persists aux selectors as `authType:modelId\0baseUrl`
    // so same-id endpoints stay distinct (#12760). The baseUrl is routing
    // metadata for the registry, not part of the model id.
    expect(resolveModelId('openai:glm-5\0https://api.example.com/v1')).toEqual({
      authType: AuthType.USE_OPENAI,
      modelId: 'glm-5',
    });
    expect(resolveModelId('glm-5\0https://api.example.com/v1')).toEqual({
      modelId: 'glm-5',
    });
  });
});
