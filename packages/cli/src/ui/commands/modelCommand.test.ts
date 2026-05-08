/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { modelCommand } from './modelCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import {
  AuthType,
  type ContentGeneratorConfig,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

// Helper function to create a mock config
function createMockConfig(
  contentGeneratorConfig: ContentGeneratorConfig | null,
): Partial<Config> {
  return {
    getContentGeneratorConfig: vi.fn().mockReturnValue(contentGeneratorConfig),
  };
}

function createMockSettings(setValue = vi.fn()): Partial<LoadedSettings> {
  return {
    merged: {},
    user: { settings: {} },
    workspace: { settings: {} },
    isTrusted: false,
    setValue,
  } as unknown as Partial<LoadedSettings>;
}

describe('modelCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
    vi.clearAllMocks();
  });

  it('should have the correct name and description', () => {
    expect(modelCommand.name).toBe('model');
    expect(modelCommand.description).toBe(
      'Switch the model for this session (--fast for suggestion model)',
    );
  });

  it('should return error when config is not available', async () => {
    mockContext.services.config = null;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    });
  });

  it('should return error when content generator config is not available', async () => {
    const mockConfig = createMockConfig(null);
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Content generator configuration not available.',
    });
  });

  it('should return error when auth type is not available', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: undefined,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Authentication type not available.',
    });
  });

  it('should return dialog action for QWEN_OAUTH auth type', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.QWEN_OAUTH,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should return dialog action for USE_OPENAI auth type', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should return dialog action for unsupported auth types', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: 'UNSUPPORTED_AUTH_TYPE' as AuthType,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'model',
    });
  });

  it('should handle undefined auth type', async () => {
    const mockConfig = createMockConfig({
      model: 'test-model',
      authType: undefined,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Authentication type not available.',
    });
  });

  it('should switch the main model directly in interactive mode when args are provided', async () => {
    const setValue = vi.fn();
    const switchModel = vi.fn().mockResolvedValue(undefined);
    mockContext = createMockCommandContext({
      invocation: { raw: '/model qwen-max', name: 'model', args: 'qwen-max' },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(mockContext, 'qwen-max');

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.QWEN_OAUTH,
      'qwen-max',
      undefined,
    );
    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'model.name',
      'qwen-max',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Model: qwen-max',
    });
  });

  it('should not persist the model when direct model switching fails', async () => {
    const setValue = vi.fn();
    const switchError = new Error('Model not found');
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model missing-model',
        name: 'model',
        args: 'missing-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          switchModel: vi.fn().mockRejectedValue(switchError),
        },
        settings: createMockSettings(setValue),
      },
    });

    await expect(
      modelCommand.action!(mockContext, 'missing-model'),
    ).rejects.toThrow('Model not found');

    expect(setValue).not.toHaveBeenCalled();
  });

  it('should reject unavailable main models for the current auth type', async () => {
    const setValue = vi.fn();
    const switchError = new Error(
      "Model 'definitely-not-a-model' not found for authType 'openai'",
    );
    const switchModel = vi.fn().mockRejectedValue(switchError);
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model definitely-not-a-model',
        name: 'model',
        args: 'definitely-not-a-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    await expect(
      modelCommand.action!(mockContext, 'definitely-not-a-model'),
    ).rejects.toThrow("Model 'definitely-not-a-model' not found");

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'definitely-not-a-model',
      undefined,
    );
    expect(setValue).not.toHaveBeenCalled();
  });

  it('should switch provider-qualified models through switchModel', async () => {
    const setValue = vi.fn();
    const switchModel = vi.fn().mockResolvedValue(undefined);
    mockContext = createMockCommandContext({
      invocation: {
        raw: `/model gpt-4(${AuthType.USE_OPENAI})`,
        name: 'model',
        args: `gpt-4(${AuthType.USE_OPENAI})`,
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          getAuthType: vi.fn().mockReturnValue(AuthType.QWEN_OAUTH),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      `gpt-4(${AuthType.USE_OPENAI})`,
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'gpt-4',
      undefined,
    );
    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'model.name',
      'gpt-4',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Model: gpt-4',
    });
  });

  it('should reject unavailable fast models for the current auth type', async () => {
    const setValue = vi.fn();
    const setFastModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --fast missing-model',
        name: 'model',
        args: '--fast missing-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'qwen-turbo', label: 'Qwen Turbo' }]),
          setFastModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--fast missing-model',
    );

    expect(setValue).not.toHaveBeenCalled();
    expect(setFastModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Fast model 'missing-model' is not available for the current authentication type.",
    });
  });

  it('should not treat model IDs prefixed with --fast as the --fast flag', async () => {
    const setValue = vi.fn();
    const switchModel = vi.fn().mockResolvedValue(undefined);
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --fast-model',
        name: 'model',
        args: '--fast-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(mockContext, '--fast-model');

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      '--fast-model',
      undefined,
    );
    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'model.name',
      '--fast-model',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Model: --fast-model',
    });
  });
});
