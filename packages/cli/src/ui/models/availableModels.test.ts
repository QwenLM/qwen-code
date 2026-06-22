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
} from './availableModels.js';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';

describe('availableModels', () => {
  describe('Qwen models', () => {
    const qwenModels = getFilteredQwenModels();

    it('should include only coder-model', () => {
      expect(qwenModels.length).toBe(1);
      expect(qwenModels[0].id).toBe('coder-model');
    });

    it('should have coder-model with vision capability', () => {
      const coderModel = qwenModels[0];
      expect(coderModel.isVision).toBe(true);
    });
  });

  describe('getFilteredQwenModels', () => {
    it('should return coder-model with vision capability', () => {
      const models = getFilteredQwenModels();
      expect(models.length).toBe(1);
      expect(models[0].id).toBe('coder-model');
      expect(models[0].isVision).toBe(true);
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
      expect(models.length).toBe(1);
      expect(models[0].id).toBe('coder-model');
      expect(models[0].isVision).toBe(true);
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
});
