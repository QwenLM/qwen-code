/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { extractModelInfoFromNewSessionResult } from './acpModelInfo.js';

describe('extractModelInfoFromNewSessionResult', () => {
  it('extracts from NewSessionResponse.models (SessionModelState)', () => {
    expect(
      extractModelInfoFromNewSessionResult({
        sessionId: 's',
        models: {
          currentModelId: 'qwen3-coder-plus',
          availableModels: [
            {
              modelId: 'qwen3-coder-plus',
              name: 'Qwen3 Coder Plus',
              description: null,
              _meta: { contextLimit: 123 },
            },
          ],
        },
      }),
    ).toEqual({
      modelId: 'qwen3-coder-plus',
      name: 'Qwen3 Coder Plus',
      description: null,
      _meta: { contextLimit: 123 },
    });
  });

  it('skips invalid model entries and returns first valid one', () => {
    expect(
      extractModelInfoFromNewSessionResult({
        models: {
          currentModelId: 'ok',
          availableModels: [
            { name: '', modelId: '' },
            { name: 'Ok', modelId: 'ok', _meta: { contextLimit: null } },
          ],
        },
      }),
    ).toEqual({ name: 'Ok', modelId: 'ok', _meta: { contextLimit: null } });
  });

  it('falls back to single `model` object', () => {
    expect(
      extractModelInfoFromNewSessionResult({
        model: {
          name: 'Single',
          modelId: 'single',
          _meta: { contextLimit: 999 },
        },
      }),
    ).toEqual({
      name: 'Single',
      modelId: 'single',
      _meta: { contextLimit: 999 },
    });
  });

  it('falls back to legacy `modelInfo`', () => {
    expect(
      extractModelInfoFromNewSessionResult({
        modelInfo: { name: 'legacy' },
      }),
    ).toEqual({ name: 'legacy', modelId: 'legacy' });
  });

  it('returns null when missing', () => {
    expect(extractModelInfoFromNewSessionResult({})).toBeNull();
    expect(extractModelInfoFromNewSessionResult(null)).toBeNull();
  });
});
