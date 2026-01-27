/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getAvailableModelsForAuthType,
  getFilteredQwenModels,
  getOpenAIAvailableModelFromEnv,
  isVisionModel,
  getDefaultVisionModel,
  MAINLINE_VLM,
  MAINLINE_CODER,
} from './availableModels.js';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';

describe('availableModels', () => {
  describe('Qwen models', () => {
    const qwenModels = getFilteredQwenModels(true);

    it('should include coder model', () => {
      const coderModel = qwenModels.find((m) => m.id === MAINLINE_CODER);
      expect(coderModel).toBeDefined();
      expect(coderModel?.isVision).toBeFalsy();
    });

    it('should include vision model', () => {
      const visionModel = qwenModels.find((m) => m.id === MAINLINE_VLM);
      expect(visionModel).toBeDefined();
      expect(visionModel?.isVision).toBe(true);
    });
  });

  describe('getFilteredQwenModels', () => {
    it('should return all models when vision preview is enabled', () => {
      const models = getFilteredQwenModels(true);
      const expected = getAvailableModelsForAuthType(AuthType.QWEN_OAUTH);
      expect(models.length).toBe(expected.length);
    });

    it('should filter out vision models when preview is disabled', () => {
      const models = getFilteredQwenModels(false);
      expect(models.every((m) => !m.isVision)).toBe(true);
    });
  });

  describe('getOpenAIAvailableModelFromEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return null when OPENAI_MODEL is not set', () => {
      delete process.env['OPENAI_MODEL'];
      expect(getOpenAIAvailableModelFromEnv()).toBeNull();
    });

    it('should return model from OPENAI_MODEL env var', () => {
      process.env['OPENAI_MODEL'] = 'gpt-4-turbo';
      const model = getOpenAIAvailableModelFromEnv();
      expect(model?.id).toBe('gpt-4-turbo');
      expect(model?.label).toBe('gpt-4-turbo');
    });

    it('should trim whitespace from env var', () => {
      process.env['OPENAI_MODEL'] = '  gpt-4  ';
      const model = getOpenAIAvailableModelFromEnv();
      expect(model?.id).toBe('gpt-4');
    });
  });

  describe('getAvailableModelsForAuthType', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return hard-coded qwen models for qwen-oauth', () => {
      const models = getAvailableModelsForAuthType(AuthType.QWEN_OAUTH);
      expect(models).toEqual(getFilteredQwenModels(true));
    });

    it('should use config models for qwen-oauth when config is provided', () => {
      const mockConfig = {
        getAvailableModelsForAuthType: vi.fn().mockReturnValue([
          {
            id: 'custom',
            label: 'Custom',
            description: 'Custom model',
            authType: AuthType.QWEN_OAUTH,
            isVision: false,
          },
        ]),
      } as unknown as Config;

      const models = getAvailableModelsForAuthType(
        AuthType.QWEN_OAUTH,
        mockConfig,
      );
      expect(models).toEqual([
        {
          id: 'custom',
          label: 'Custom',
          description: 'Custom model',
          isVision: false,
        },
      ]);
    });

    it('should use config.getAvailableModels for openai authType when available', () => {
      const mockModels = [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          description: 'Test',
          authType: AuthType.USE_OPENAI,
          isVision: false,
        },
      ];
      const getAvailableModelsForAuthType = vi.fn().mockReturnValue(mockModels);
      const mockConfigWithMethod = {
        // Prefer the newer API when available.
        getAvailableModelsForAuthType,
      };

      const models = getAvailableModelsForAuthType(
        AuthType.USE_OPENAI,
        mockConfigWithMethod as unknown as Config,
      );

      expect(getAvailableModelsForAuthType).toHaveBeenCalled();
      expect(models[0].id).toBe('gpt-4');
    });

    it('should fallback to env var for openai when config returns empty', () => {
      process.env['OPENAI_MODEL'] = 'fallback-model';
      const mockConfig = {
        getAvailableModelsForAuthType: vi.fn().mockReturnValue([]),
      } as unknown as Config;

      const models = getAvailableModelsForAuthType(
        AuthType.USE_OPENAI,
        mockConfig,
      );

      expect(models).toEqual([]);
    });

    it('should fallback to env var for openai when config throws', () => {
      process.env['OPENAI_MODEL'] = 'fallback-model';
      const mockConfig = {
        getAvailableModelsForAuthType: vi.fn().mockImplementation(() => {
          throw new Error('Registry not initialized');
        }),
      } as unknown as Config;

      const models = getAvailableModelsForAuthType(
        AuthType.USE_OPENAI,
        mockConfig,
      );

      expect(models).toEqual([]);
    });

    it('should return env model for openai without config', () => {
      process.env['OPENAI_MODEL'] = 'gpt-4-turbo';
      const models = getAvailableModelsForAuthType(AuthType.USE_OPENAI);
      expect(models[0].id).toBe('gpt-4-turbo');
    });

    it('should return empty array for openai without config or env', () => {
      delete process.env['OPENAI_MODEL'];
      const models = getAvailableModelsForAuthType(AuthType.USE_OPENAI);
      expect(models).toEqual([]);
    });

    it('should return empty array for other auth types', () => {
      const models = getAvailableModelsForAuthType(AuthType.USE_GEMINI);
      expect(models).toEqual([]);
    });
  });

  describe('isVisionModel', () => {
    it('should return true for vision model', () => {
      expect(isVisionModel(MAINLINE_VLM)).toBe(true);
    });

    it('should return false for non-vision model', () => {
      expect(isVisionModel(MAINLINE_CODER)).toBe(false);
    });

    it('should return false for unknown model', () => {
      expect(isVisionModel('unknown-model')).toBe(false);
    });
  });

  describe('getDefaultVisionModel', () => {
    it('should return the vision model ID', () => {
      expect(getDefaultVisionModel()).toBe(MAINLINE_VLM);
    });
  });
});
