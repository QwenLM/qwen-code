/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelSelectionManager } from './modelSelectionManager.js';
import { AuthType } from '../core/contentGenerator.js';
import { SelectionSource } from './types.js';
import type { ModelProvidersConfig } from './types.js';

describe('ModelSelectionManager', () => {
  let manager: ModelSelectionManager;

  const defaultConfig: ModelProvidersConfig = {
    openai: [
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        baseUrl: 'https://api.openai.com/v1',
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        baseUrl: 'https://api.openai.com/v1',
      },
      {
        id: 'deepseek-coder',
        name: 'DeepSeek Coder',
        baseUrl: 'https://api.deepseek.com/v1',
      },
    ],
  };

  describe('initialization', () => {
    it('should initialize with default qwen-oauth authType and coder-model', () => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
      });

      expect(manager.getCurrentAuthType()).toBe(AuthType.QWEN_OAUTH);
      expect(manager.getCurrentModelId()).toBe('coder-model');
      expect(manager.getSelectionSource()).toBe(SelectionSource.DEFAULT);
    });

    it('should initialize with specified authType and model', () => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
        initialAuthType: AuthType.USE_OPENAI,
        initialModelId: 'gpt-4-turbo',
      });

      expect(manager.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
      expect(manager.getCurrentModelId()).toBe('gpt-4-turbo');
      expect(manager.getSelectionSource()).toBe(SelectionSource.SETTINGS);
    });

    it('should fallback to default model if specified model not found', () => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
        initialAuthType: AuthType.USE_OPENAI,
        initialModelId: 'non-existent',
      });

      expect(manager.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
      // Should fallback to first model
      expect(manager.getCurrentModelId()).toBe('gpt-4-turbo');
    });
  });

  describe('switchModel', () => {
    beforeEach(() => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
        initialAuthType: AuthType.USE_OPENAI,
        initialModelId: 'gpt-4-turbo',
      });
    });

    it('should switch model within same authType', async () => {
      await manager.switchModel('gpt-3.5-turbo', SelectionSource.USER_MANUAL);

      expect(manager.getCurrentModelId()).toBe('gpt-3.5-turbo');
      expect(manager.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
    });

    it('should update selection source on switch', async () => {
      await manager.switchModel('gpt-3.5-turbo', SelectionSource.USER_MANUAL);

      expect(manager.getSelectionSource()).toBe(SelectionSource.USER_MANUAL);
    });

    it('should call onModelChange callback', async () => {
      const onModelChange = vi.fn();
      manager.setOnModelChange(onModelChange);

      await manager.switchModel('gpt-3.5-turbo', SelectionSource.USER_MANUAL);

      expect(onModelChange).toHaveBeenCalledTimes(1);
      expect(onModelChange).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        expect.objectContaining({ id: 'gpt-3.5-turbo' }),
      );
    });

    it('should throw error for non-existent model', async () => {
      await expect(
        manager.switchModel('non-existent', SelectionSource.USER_MANUAL),
      ).rejects.toThrow('not found for authType');
    });

    it('should allow any source to override previous selection', async () => {
      // First set to USER_MANUAL
      await manager.switchModel('gpt-3.5-turbo', SelectionSource.USER_MANUAL);
      expect(manager.getCurrentModelId()).toBe('gpt-3.5-turbo');

      // Should allow PROGRAMMATIC_OVERRIDE to override USER_MANUAL
      await manager.switchModel(
        'gpt-4-turbo',
        SelectionSource.PROGRAMMATIC_OVERRIDE,
      );
      expect(manager.getCurrentModelId()).toBe('gpt-4-turbo');

      // Should allow SETTINGS to override PROGRAMMATIC_OVERRIDE
      await manager.switchModel('gpt-3.5-turbo', SelectionSource.SETTINGS);
      expect(manager.getCurrentModelId()).toBe('gpt-3.5-turbo');
    });
  });

  describe('getAvailableModels', () => {
    it('should return models for current authType', () => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
        initialAuthType: AuthType.USE_OPENAI,
      });

      const models = manager.getAvailableModels();
      expect(models.length).toBe(3);
      expect(models.map((m) => m.id)).toContain('gpt-4-turbo');
    });

    it('should return qwen-oauth models by default', () => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
      });

      const models = manager.getAvailableModels();
      expect(models.some((m) => m.id === 'coder-model')).toBe(true);
      expect(models.some((m) => m.id === 'vision-model')).toBe(true);
    });
  });

  describe('getAvailableAuthTypes', () => {
    it('should return all available authTypes', () => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
      });

      const authTypes = manager.getAvailableAuthTypes();
      expect(authTypes).toContain(AuthType.QWEN_OAUTH);
      expect(authTypes).toContain(AuthType.USE_OPENAI);
    });
  });

  describe('getCurrentModel', () => {
    beforeEach(() => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
        initialAuthType: AuthType.USE_OPENAI,
        initialModelId: 'gpt-4-turbo',
      });
    });

    it('should return current model info', () => {
      const modelInfo = manager.getCurrentModel();

      expect(modelInfo.authType).toBe(AuthType.USE_OPENAI);
      expect(modelInfo.modelId).toBe('gpt-4-turbo');
      expect(modelInfo.model.id).toBe('gpt-4-turbo');
      expect(modelInfo.selectionSource).toBe(SelectionSource.SETTINGS);
    });

    it('should throw error if no model selected', () => {
      // Create manager with invalid initial state
      const mgr = new ModelSelectionManager({
        modelProvidersConfig: { openai: [] },
        initialAuthType: AuthType.USE_OPENAI,
      });

      expect(() => mgr.getCurrentModel()).toThrow('No model selected');
    });
  });

  describe('selection timestamp', () => {
    it('should update timestamp on model switch', async () => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
        initialAuthType: AuthType.USE_OPENAI,
        initialModelId: 'gpt-4-turbo',
      });

      const initialTimestamp = manager.getSelectionTimestamp();

      // Wait a small amount to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      await manager.switchModel('gpt-3.5-turbo', SelectionSource.USER_MANUAL);

      expect(manager.getSelectionTimestamp()).toBeGreaterThan(initialTimestamp);
    });
  });

  describe('delegation methods', () => {
    beforeEach(() => {
      manager = new ModelSelectionManager({
        modelProvidersConfig: defaultConfig,
      });
    });

    it('should delegate hasModel to registry', () => {
      expect(manager.hasModel(AuthType.QWEN_OAUTH, 'coder-model')).toBe(true);
      expect(manager.hasModel(AuthType.QWEN_OAUTH, 'non-existent')).toBe(false);
    });

    it('should delegate getModel to registry', () => {
      const model = manager.getModel(AuthType.QWEN_OAUTH, 'coder-model');
      expect(model).toBeDefined();
      expect(model?.id).toBe('coder-model');

      const nonExistent = manager.getModel(AuthType.QWEN_OAUTH, 'non-existent');
      expect(nonExistent).toBeUndefined();
    });
  });
});
