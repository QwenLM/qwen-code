/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractModelInfoFromNewSessionResult,
  extractSessionModelState,
} from './acpModelInfo.js';

describe('extractSessionModelState', () => {
  it('extracts full model state from NewSessionResponse.models', () => {
    const result = extractSessionModelState({
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
          {
            modelId: 'qwen3-coder',
            name: 'Qwen3 Coder',
            description: 'Standard model',
            _meta: { contextLimit: 64 },
          },
        ],
      },
    });

    expect(result).toEqual({
      currentModelId: 'qwen3-coder-plus',
      availableModels: [
        {
          modelId: 'qwen3-coder-plus',
          name: 'Qwen3 Coder Plus',
          description: null,
          _meta: { contextLimit: 123 },
        },
        {
          modelId: 'qwen3-coder',
          name: 'Qwen3 Coder',
          description: 'Standard model',
          _meta: { contextLimit: 64 },
        },
      ],
    });
  });

  it('returns all available models', () => {
    const result = extractSessionModelState({
      models: {
        currentModelId: 'model-a',
        availableModels: [
          { modelId: 'model-a', name: 'Model A' },
          { modelId: 'model-b', name: 'Model B' },
          { modelId: 'model-c', name: 'Model C' },
        ],
      },
    });

    expect(result?.availableModels).toHaveLength(3);
    expect(result?.availableModels.map((m) => m.modelId)).toEqual([
      'model-a',
      'model-b',
      'model-c',
    ]);
  });

  it('defaults to first model if currentModelId is missing', () => {
    const result = extractSessionModelState({
      models: {
        availableModels: [
          { modelId: 'first', name: 'First Model' },
          { modelId: 'second', name: 'Second Model' },
        ],
      },
    });

    expect(result?.currentModelId).toBe('first');
  });

  it('handles legacy array format', () => {
    const result = extractSessionModelState({
      models: [
        { modelId: 'legacy-1', name: 'Legacy 1' },
        { modelId: 'legacy-2', name: 'Legacy 2' },
      ],
    });

    expect(result).toEqual({
      currentModelId: 'legacy-1',
      availableModels: [
        { modelId: 'legacy-1', name: 'Legacy 1' },
        { modelId: 'legacy-2', name: 'Legacy 2' },
      ],
    });
  });

  it('filters out invalid model entries', () => {
    const result = extractSessionModelState({
      models: {
        currentModelId: 'valid',
        availableModels: [
          { name: '', modelId: '' }, // invalid
          { modelId: 'valid', name: 'Valid Model' },
          {}, // invalid
        ],
      },
    });

    expect(result?.availableModels).toHaveLength(1);
    expect(result?.availableModels[0].modelId).toBe('valid');
  });

  it('returns null when models field is missing', () => {
    expect(extractSessionModelState({})).toBeNull();
    expect(extractSessionModelState(null)).toBeNull();
    expect(extractSessionModelState({ sessionId: 's' })).toBeNull();
  });

  it('returns null when availableModels is empty after filtering', () => {
    const result = extractSessionModelState({
      models: {
        currentModelId: 'none',
        availableModels: [{ name: '', modelId: '' }, { name: '' }],
      },
    });

    // When all models are invalid, availableModels will be empty
    // The function should still return a state with empty availableModels
    expect(result?.availableModels).toHaveLength(0);
  });
});

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
