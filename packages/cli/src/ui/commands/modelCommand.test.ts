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
      'Switch the model for this session (--fast for suggestion model, --voice for voice transcription model, --vision for the vision bridge model, --project to persist to project settings, --global to persist to user settings, [model-id] to switch immediately, or [model-id] [prompt] to run a one-off prompt on another model; the inline prompt is sent verbatim without @file expansion).',
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
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'qwen-max', label: 'Qwen Max' }]),
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
    // `/model <id>` is an id-only switch, so any baseUrl disambiguator left by
    // a previous model-picker selection must be cleared (empty-string tombstone)
    // to avoid resolving to a different provider on next launch.
    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'model.baseUrl',
      '',
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Model: qwen-max',
    });
  });

  it('runs a trailing prompt on the given model inline without switching or persisting', async () => {
    const setValue = vi.fn();
    const switchModel = vi.fn().mockResolvedValue(undefined);
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model qwen-max explain this code',
        name: 'model',
        args: 'qwen-max explain this code',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'qwen-max', label: 'Qwen Max' }]),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      'qwen-max explain this code',
    );

    // Inline override is per-turn: no session switch, no persistence.
    expect(switchModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'explain this code',
      modelOverride: 'qwen-max',
    });
  });

  it('rejects an inline prompt when the model id is not available', async () => {
    const switchModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model missing-model hello',
        name: 'model',
        args: 'missing-model hello',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          switchModel,
          getAvailableModelsForAuthType: vi.fn().mockReturnValue([]),
        },
        settings: createMockSettings(vi.fn()),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      'missing-model hello',
    );

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
  });

  it('rejects an inline prompt that targets a different provider', async () => {
    const switchModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model gpt-4(openai) hello',
        name: 'model',
        args: 'gpt-4(openai) hello',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          switchModel,
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'gpt-4', label: 'GPT-4' }]),
        },
        settings: createMockSettings(vi.fn()),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      'gpt-4(openai) hello',
    );

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('different provider'),
    });
  });

  it('rejects an inline prompt whose model belongs to a same-auth-type provider with a different endpoint/credentials', async () => {
    const switchModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model shared-id hello',
        name: 'model',
        args: 'shared-id hello',
      },
      services: {
        config: {
          // Active provider: one OpenAI-compatible endpoint/credential.
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-a.example/v1',
            apiKeyEnvKey: 'PROVIDER_A_KEY',
          }),
          switchModel,
          // Same id + auth type, but a different provider's endpoint/credential.
          getAvailableModelsForAuthType: vi.fn().mockReturnValue([
            {
              id: 'shared-id',
              label: 'Shared',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://provider-b.example/v1',
              envKey: 'PROVIDER_B_KEY',
            },
          ]),
        },
        settings: createMockSettings(vi.fn()),
      },
    });

    const result = await modelCommand.action!(mockContext, 'shared-id hello');

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('different provider'),
    });
  });

  it('runs an inline prompt when the model matches the active provider endpoint/credentials', async () => {
    const switchModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model shared-id hello there',
        name: 'model',
        args: 'shared-id hello there',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'other',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://provider-a.example/v1',
            apiKeyEnvKey: 'PROVIDER_A_KEY',
          }),
          switchModel,
          getAvailableModelsForAuthType: vi.fn().mockReturnValue([
            {
              id: 'shared-id',
              label: 'Shared',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://provider-a.example/v1',
              envKey: 'PROVIDER_A_KEY',
            },
          ]),
        },
        settings: createMockSettings(vi.fn()),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      'shared-id hello there',
    );

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'submit_prompt',
      content: 'hello there',
      modelOverride: 'shared-id',
    });
  });

  it('rejects an inline prompt in ACP mode (no per-turn override pipeline)', async () => {
    const switchModel = vi.fn();
    mockContext = createMockCommandContext({
      executionMode: 'acp',
      invocation: {
        raw: '/model qwen-max explain this',
        name: 'model',
        args: 'qwen-max explain this',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          switchModel,
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'qwen-max', label: 'Qwen Max' }]),
        },
        settings: createMockSettings(vi.fn()),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      'qwen-max explain this',
    );

    expect(switchModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', messageType: 'error' });
  });

  it('should not persist the model when direct model validation fails', async () => {
    const setValue = vi.fn();
    const switchModel = vi.fn();
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
          switchModel,
          getAvailableModelsForAuthType: vi.fn().mockReturnValue([]),
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(mockContext, 'missing-model');

    expect(switchModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Model 'missing-model' is not available for auth type 'qwen-oauth'.\n" +
        "No models are configured for auth type 'qwen-oauth'.\n" +
        'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model without arguments to choose from configured models.',
    });
  });

  it('should not persist the model when direct model switching fails after validation', async () => {
    const setValue = vi.fn();
    const switchError = new Error('Refresh failed');
    const switchModel = vi.fn().mockRejectedValue(switchError);
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model qwen-max',
        name: 'model',
        args: 'qwen-max',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.QWEN_OAUTH,
          }),
          switchModel,
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'qwen-max', label: 'Qwen Max' }]),
        },
        settings: createMockSettings(setValue),
      },
    });

    await expect(modelCommand.action!(mockContext, 'qwen-max')).rejects.toThrow(
      'Refresh failed',
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.QWEN_OAUTH,
      'qwen-max',
      undefined,
    );
    expect(setValue).not.toHaveBeenCalled();
  });

  it('should explain how to configure models when direct switching fails', async () => {
    const setValue = vi.fn();
    const switchModel = vi.fn();
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
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'gpt-4', label: 'GPT-4' }]),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      'definitely-not-a-model',
    );

    expect(switchModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Model 'definitely-not-a-model' is not available for auth type 'openai'.\n" +
        "Available models for 'openai': gpt-4.\n" +
        'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model without arguments to choose from configured models.',
    });
  });

  it('should explain when no models are configured for direct switching', async () => {
    const setValue = vi.fn();
    const switchModel = vi
      .fn()
      .mockRejectedValue(
        new Error("Model 'gpt-4o' not found for authType 'openai'"),
      );
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model gpt-4o',
        name: 'model',
        args: 'gpt-4o',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAvailableModelsForAuthType: vi.fn().mockReturnValue([]),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(mockContext, 'gpt-4o');

    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Model 'gpt-4o' is not available for auth type 'openai'.\n" +
        "No models are configured for auth type 'openai'.\n" +
        'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model without arguments to choose from configured models.',
    });
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
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: 'gpt-4', label: 'GPT-4' }]),
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

  it('should set fast models configured under another auth type', async () => {
    const setValue = vi.fn();
    const setFastModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --fast deepseek-v4-flash',
        name: 'model',
        args: '--fast deepseek-v4-flash',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'claude-opus-4-7',
            authType: AuthType.USE_ANTHROPIC,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'deepseek-v4-flash',
              label: 'deepseek-v4-flash',
              authType: AuthType.USE_OPENAI,
            },
            {
              id: 'claude-opus-4-7',
              label: 'claude-opus-4-7',
              authType: AuthType.USE_ANTHROPIC,
            },
          ]),
          setFastModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--fast deepseek-v4-flash',
    );

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'fastModel',
      'deepseek-v4-flash',
    );
    expect(setFastModel).toHaveBeenCalledWith('deepseek-v4-flash');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Fast Model: deepseek-v4-flash',
    });
  });

  it('should set authType-qualified fast model selectors', async () => {
    const setValue = vi.fn();
    const setFastModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --fast openai:deepseek-v4-flash',
        name: 'model',
        args: '--fast openai:deepseek-v4-flash',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'claude-opus-4-7',
            authType: AuthType.USE_ANTHROPIC,
          }),
          getAvailableModelsForAuthType: vi.fn((authType: AuthType) =>
            authType === AuthType.USE_OPENAI
              ? [
                  {
                    id: 'deepseek-v4-flash',
                    label: 'deepseek-v4-flash',
                    authType: AuthType.USE_OPENAI,
                  },
                ]
              : [],
          ),
          setFastModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--fast openai:deepseek-v4-flash',
    );

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'fastModel',
      'openai:deepseek-v4-flash',
    );
    expect(setFastModel).toHaveBeenCalledWith('openai:deepseek-v4-flash');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Fast Model: openai:deepseek-v4-flash',
    });
  });

  it('should reject unavailable fast models across all auth types', async () => {
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
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen-turbo',
              label: 'Qwen Turbo',
              authType: AuthType.USE_OPENAI,
            },
          ]),
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
        "Fast model 'missing-model' is not configured for any auth type.\n" +
        'Configured models: qwen-turbo.\n' +
        'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model --fast without a model to choose from configured models.',
    });
  });

  it('should reject unavailable authType-qualified fast models', async () => {
    const setValue = vi.fn();
    const setFastModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --fast openai:missing-model',
        name: 'model',
        args: '--fast openai:missing-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'claude-opus-4-7',
            authType: AuthType.USE_ANTHROPIC,
          }),
          getAvailableModelsForAuthType: vi.fn((authType: AuthType) =>
            authType === AuthType.USE_OPENAI
              ? [{ id: 'gpt-4', label: 'GPT-4', authType }]
              : [],
          ),
          setFastModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--fast openai:missing-model',
    );

    expect(setValue).not.toHaveBeenCalled();
    expect(setFastModel).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Fast model 'missing-model' is not available for auth type 'openai'.\n" +
        "Available models for 'openai': gpt-4.\n" +
        'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model --fast without a model to choose from configured models.',
    });
  });

  it('should set the vision bridge model', async () => {
    const setValue = vi.fn();
    const setVisionModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --vision qwen-vl-max',
        name: 'model',
        args: '--vision qwen-vl-max',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen-vl-max',
              label: 'qwen-vl-max',
              authType: AuthType.USE_OPENAI,
            },
          ]),
          isCurrentPrimaryModel: (m: { id: string }) => m.id === 'qwen-plus',
          setVisionModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--vision qwen-vl-max',
    );

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'visionModel',
      'qwen-vl-max',
    );
    expect(setVisionModel).toHaveBeenCalledWith('qwen-vl-max');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Vision Model: qwen-vl-max',
    });
  });

  it('should set authType-qualified vision model selectors', async () => {
    const setValue = vi.fn();
    const setVisionModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --vision openai:qwen-vl-max',
        name: 'model',
        args: '--vision openai:qwen-vl-max',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'claude-opus-4-7',
            authType: AuthType.USE_ANTHROPIC,
          }),
          getAvailableModelsForAuthType: vi.fn((authType: AuthType) =>
            authType === AuthType.USE_OPENAI
              ? [
                  {
                    id: 'qwen-vl-max',
                    label: 'qwen-vl-max',
                    authType: AuthType.USE_OPENAI,
                  },
                ]
              : [],
          ),
          // The pinned model lives on a different provider than the primary, so
          // the set-time primary guard (config.isCurrentPrimaryModel) never fires.
          isCurrentPrimaryModel: (m: { id: string }) =>
            m.id === 'claude-opus-4-7',
          setVisionModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--vision openai:qwen-vl-max',
    );

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'visionModel',
      'openai:qwen-vl-max',
    );
    expect(setVisionModel).toHaveBeenCalledWith('openai:qwen-vl-max');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Vision Model: openai:qwen-vl-max',
    });
  });

  it('rejects a malformed --vision selector with no model id', async () => {
    // `openai:` is a known authType with no model id — resolveModelId throws.
    // The --vision handler's try/catch must turn that into an error result
    // instead of letting the exception escape or persisting a half-baked pin.
    const setValue = vi.fn();
    const setVisionModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --vision openai:',
        name: 'model',
        args: '--vision openai:',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([]),
          setVisionModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(mockContext, '--vision openai:');

    expect(setValue).not.toHaveBeenCalled();
    expect(setVisionModel).not.toHaveBeenCalled();
    const msg = result as { messageType: string };
    expect(msg.messageType).toBe('error');
  });

  it('still sets a non-image-capable vision model but warns', async () => {
    const setValue = vi.fn();
    const setVisionModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --vision qwen3.7-max',
        name: 'model',
        args: '--vision qwen3.7-max',
      },
      services: {
        config: {
          // Primary differs from the pinned model so the guard doesn't fire.
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          // qwen3.7-max is text-only (no modalities / isVision) → bridge can't use it.
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen3.7-max',
              label: 'qwen3.7-max',
              authType: AuthType.USE_OPENAI,
            },
          ]),
          isCurrentPrimaryModel: (m: { id: string }) => m.id === 'qwen-plus',
          setVisionModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--vision qwen3.7-max',
    );

    // The pin is still honored...
    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'visionModel',
      'qwen3.7-max',
    );
    expect(setVisionModel).toHaveBeenCalledWith('qwen3.7-max');
    // ...but the confirmation warns it isn't image-capable.
    const msg = result as { messageType: string; content: string };
    expect(msg.messageType).toBe('info');
    expect(msg.content).toContain('Vision Model: qwen3.7-max');
    expect(msg.content).toMatch(/not a known image-capable model/i);
  });

  it('rejects pinning the current primary model as the vision bridge', async () => {
    const setValue = vi.fn();
    const setVisionModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --vision qwen-plus',
        name: 'model',
        args: '--vision qwen-plus',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen-plus',
              label: 'qwen-plus',
              authType: AuthType.USE_OPENAI,
            },
          ]),
          // qwen-plus IS the current primary, so it can't double as the vision
          // bridge — the runtime guard would silently ignore the pin.
          isCurrentPrimaryModel: (m: { id: string }) => m.id === 'qwen-plus',
          setVisionModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--vision qwen-plus',
    );

    const msg = result as { messageType: string; content: string };
    expect(msg.messageType).toBe('error');
    expect(msg.content).toMatch(/current primary model/i);
    expect(setVisionModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });

  it('should reject unavailable vision models across all auth types', async () => {
    const setValue = vi.fn();
    const setVisionModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --vision missing-model',
        name: 'model',
        args: '--vision missing-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen-vl-max',
              label: 'qwen-vl-max',
              authType: AuthType.USE_OPENAI,
            },
          ]),
          setVisionModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--vision missing-model',
    );

    expect(setVisionModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Vision model 'missing-model' is not configured for any auth type.\n" +
        'Configured models: qwen-vl-max.\n' +
        'Configure an image-capable model in settings.modelProviders and ensure the required environment variables are set. Run /model --vision <model-id> to set it, or leave it unset to auto-pick a same-provider vision model.',
    });
  });

  it('should reject an authType-qualified vision model missing from that provider', async () => {
    // Exercises the `selector.authType` branch: a qualified id absent from that
    // provider's list reports the per-authType message, not the all-providers one.
    const setValue = vi.fn();
    const setVisionModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --vision openai:ghost-model',
        name: 'model',
        args: '--vision openai:ghost-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAvailableModelsForAuthType: vi.fn().mockReturnValue([
            {
              id: 'qwen-vl-max',
              label: 'qwen-vl-max',
              authType: AuthType.USE_OPENAI,
            },
          ]),
          setVisionModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--vision openai:ghost-model',
    );

    expect(setVisionModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Vision model 'ghost-model' is not available for auth type 'openai'.\n" +
        "Available models for 'openai': qwen-vl-max.\n" +
        'Configure an image-capable model in settings.modelProviders and ensure the required environment variables are set. Run /model --vision <model-id> to set it, or leave it unset to auto-pick a same-provider vision model.',
    });
  });

  it('should open the vision model dialog for /model --vision in interactive mode', async () => {
    const mockConfig = createMockConfig({
      model: 'qwen-plus',
      authType: AuthType.USE_OPENAI,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '--vision');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'vision-model',
    });
  });

  it('should return current vision model outside interactive mode', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      invocation: { args: '--vision' },
      services: {
        config: createMockConfig({
          model: 'qwen-max',
          authType: AuthType.USE_OPENAI,
        }),
        settings: {
          merged: { visionModel: 'qwen-vl-max' } as Record<string, unknown>,
        },
      },
    });

    const result = await modelCommand.action!(mockContext, '--vision');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Current vision model: qwen-vl-max\nUse "/model --vision <model-id>" to set the vision bridge model.',
    });
  });

  it('should open the voice model dialog for /model --voice in interactive mode', async () => {
    const mockConfig = createMockConfig({
      model: 'qwen-plus',
      authType: AuthType.USE_OPENAI,
    });
    mockContext.services.config = mockConfig as Config;

    const result = await modelCommand.action!(mockContext, '--voice');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'voice-model',
    });
  });

  it('should return current voice model outside interactive mode', async () => {
    mockContext = createMockCommandContext({
      executionMode: 'non_interactive',
      invocation: { args: '--voice' },
      services: {
        config: createMockConfig({
          model: 'qwen-max',
          authType: AuthType.USE_OPENAI,
        }),
        settings: {
          merged: { voiceModel: 'qwen3-asr-flash' } as Record<string, unknown>,
        },
      },
    });

    const result = await modelCommand.action!(mockContext, '--voice');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content:
        'Current voice model: qwen3-asr-flash\nUse "/model --voice <model-id>" to set voice model.',
    });
  });

  it('should set voice model without switching the main model', async () => {
    const setValue = vi.fn();
    const switchModel = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --voice qwen3-asr-flash',
        name: 'model',
        args: '--voice qwen3-asr-flash',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen3-asr-flash',
              label: 'qwen3-asr-flash',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://dashscope.example/v1',
            },
          ]),
          switchModel,
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--voice qwen3-asr-flash',
    );

    expect(setValue).toHaveBeenCalledWith(
      expect.any(String),
      'voiceModel',
      'qwen3-asr-flash',
    );
    expect(switchModel).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalledWith(
      expect.any(String),
      'model.name',
      expect.any(String),
    );
    expect(setValue).not.toHaveBeenCalledWith(
      expect.any(String),
      'fastModel',
      expect.any(String),
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Voice Model: qwen3-asr-flash',
    });
  });

  it('should reject unavailable voice models', async () => {
    const setValue = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --voice missing-model',
        name: 'model',
        args: '--voice missing-model',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen3-asr-flash',
              label: 'qwen3-asr-flash',
              authType: AuthType.USE_OPENAI,
            },
          ]),
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--voice missing-model',
    );

    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Voice model 'missing-model' is not configured.\n" +
        'Configured models: qwen3-asr-flash.\n' +
        'Configure a unique model id in settings.modelProviders or run /model --voice to select an available model.',
    });
  });

  it('should reject voice models that cannot use the transcription endpoint', async () => {
    const setValue = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --voice qwen3-coder',
        name: 'model',
        args: '--voice qwen3-coder',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen3-coder',
              label: 'qwen3-coder',
              authType: AuthType.USE_OPENAI,
            },
          ]),
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--voice qwen3-coder',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Voice model 'qwen3-coder' cannot be used for transcription. Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.",
    });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('should reject non OpenAI-compatible voice models', async () => {
    const setValue = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --voice claude-sonnet',
        name: 'model',
        args: '--voice claude-sonnet',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'claude-sonnet',
              label: 'claude-sonnet',
              authType: AuthType.USE_ANTHROPIC,
              baseUrl: 'https://anthropic.example/v1',
            },
          ]),
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--voice claude-sonnet',
    );

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Voice model 'claude-sonnet' cannot be used for transcription. Configure an OpenAI-compatible model with baseUrl in settings.modelProviders.",
    });
    expect(setValue).not.toHaveBeenCalled();
  });

  it('should reject duplicate voice model ids as ambiguous', async () => {
    const setValue = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --voice qwen3-asr-flash',
        name: 'model',
        args: '--voice qwen3-asr-flash',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen3-asr-flash',
              label: 'first',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://one.example/v1',
            },
            {
              id: 'qwen3-asr-flash',
              label: 'second',
              authType: AuthType.USE_OPENAI,
              baseUrl: 'https://two.example/v1',
            },
          ]),
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--voice qwen3-asr-flash',
    );

    expect(setValue).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        "Voice model 'qwen3-asr-flash' is ambiguous. Configure a unique model id before using /model --voice.",
    });
  });

  it('should treat colon-containing voice model values as literal ids', async () => {
    const setValue = vi.fn();
    mockContext = createMockCommandContext({
      invocation: {
        raw: '/model --voice openai:qwen3-asr-flash',
        name: 'model',
        args: '--voice openai:qwen3-asr-flash',
      },
      services: {
        config: {
          getContentGeneratorConfig: vi.fn().mockReturnValue({
            model: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          }),
          getAllConfiguredModels: vi.fn().mockReturnValue([
            {
              id: 'qwen3-asr-flash',
              label: 'qwen3-asr-flash',
              authType: AuthType.USE_OPENAI,
            },
          ]),
        },
        settings: createMockSettings(setValue),
      },
    });

    const result = await modelCommand.action!(
      mockContext,
      '--voice openai:qwen3-asr-flash',
    );

    expect(setValue).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining(
        "Voice model 'openai:qwen3-asr-flash' is not configured.",
      ),
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
          getAvailableModelsForAuthType: vi
            .fn()
            .mockReturnValue([{ id: '--fast-model', label: '--fast-model' }]),
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

  describe('non-interactive mode', () => {
    it('should use interactive-only wording for unavailable direct switches', async () => {
      const setValue = vi.fn();
      const switchModel = vi.fn();
      mockContext = createMockCommandContext({
        executionMode: 'non_interactive',
        invocation: {
          raw: '/model missing-model',
          name: 'model',
          args: 'missing-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'qwen-plus',
              authType: AuthType.USE_OPENAI,
            }),
            getAvailableModelsForAuthType: vi
              .fn()
              .mockReturnValue([{ id: 'gpt-4', label: 'GPT-4' }]),
            switchModel,
          },
          settings: createMockSettings(setValue),
        },
      });

      const result = await modelCommand.action!(mockContext, 'missing-model');

      expect(switchModel).not.toHaveBeenCalled();
      expect(setValue).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          "Model 'missing-model' is not available for auth type 'openai'.\n" +
          "Available models for 'openai': gpt-4.\n" +
          'Configure models in settings.modelProviders and ensure the required environment variables are set. In interactive mode, run /auth to configure or switch providers, or run /model without arguments to choose from configured models.',
      });
    });

    it('should return current model without triggering dialog when no args', async () => {
      mockContext = createMockCommandContext({
        executionMode: 'non_interactive',
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'qwen-max',
              authType: AuthType.QWEN_OAUTH,
            }),
            getModel: vi.fn().mockReturnValue('qwen-max'),
          },
        },
      });

      const result = await modelCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('qwen-max'),
      });
      expect((result as { type: string }).type).toBe('message');
    });

    it('should return current fast model without triggering dialog for --fast no args', async () => {
      mockContext = createMockCommandContext({
        executionMode: 'non_interactive',
        invocation: { args: '--fast' },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'qwen-max',
              authType: AuthType.QWEN_OAUTH,
            }),
            getModel: vi.fn().mockReturnValue('qwen-max'),
          },
          settings: {
            merged: { fastModel: 'qwen-turbo' } as Record<string, unknown>,
          },
        },
      });

      const result = await modelCommand.action!(mockContext, '--fast');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('qwen-turbo'),
      });
    });
  });

  describe('fastOnly/voiceOnly filtering', () => {
    it('should reject fastOnly models from normal /model selection', async () => {
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model fast-model',
          name: 'model',
          args: 'fast-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAvailableModelsForAuthType: vi.fn().mockReturnValue([
              { id: 'main-model', label: 'Main' },
              { id: 'fast-model', label: 'Fast', fastOnly: true },
            ]),
          },
          settings: createMockSettings(),
        },
      });

      const result = await modelCommand.action!(mockContext, 'fast-model');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('fast-model'),
      });
    });

    it('should reject voiceOnly models from normal /model selection', async () => {
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model voice-model',
          name: 'model',
          args: 'voice-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAvailableModelsForAuthType: vi.fn().mockReturnValue([
              { id: 'main-model', label: 'Main' },
              { id: 'voice-model', label: 'Voice', voiceOnly: true },
            ]),
          },
          settings: createMockSettings(),
        },
      });

      const result = await modelCommand.action!(mockContext, 'voice-model');
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('voice-model'),
      });
    });

    it('should allow fastOnly models in --fast selection', async () => {
      const setValue = vi.fn();
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model --fast fast-model',
          name: 'model',
          args: '--fast fast-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAllConfiguredModels: vi.fn().mockReturnValue([
              { id: 'main-model', label: 'Main' },
              { id: 'fast-model', label: 'Fast', fastOnly: true },
            ]),
            setFastModel: vi.fn(),
          },
          settings: createMockSettings(setValue),
        },
      });

      const result = await modelCommand.action!(
        mockContext,
        '--fast fast-model',
      );
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('fast-model'),
      });
    });

    it('should reject voiceOnly models from --fast selection', async () => {
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model --fast voice-model',
          name: 'model',
          args: '--fast voice-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAllConfiguredModels: vi.fn().mockReturnValue([
              { id: 'main-model', label: 'Main' },
              { id: 'voice-model', label: 'Voice', voiceOnly: true },
            ]),
            setFastModel: vi.fn(),
          },
          settings: createMockSettings(),
        },
      });

      const result = await modelCommand.action!(
        mockContext,
        '--fast voice-model',
      );
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('voice-model'),
      });
    });

    it('should not filter out voiceOnly models from --voice selection', async () => {
      const setValue = vi.fn();
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model --voice qwen3-asr-flash',
          name: 'model',
          args: '--voice qwen3-asr-flash',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAllConfiguredModels: vi.fn().mockReturnValue([
              {
                id: 'main-model',
                label: 'Main',
                authType: AuthType.USE_OPENAI,
              },
              {
                id: 'qwen3-asr-flash',
                label: 'ASR',
                voiceOnly: true,
                authType: AuthType.USE_OPENAI,
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              },
            ]),
          },
          settings: createMockSettings(setValue),
        },
      });

      const result = await modelCommand.action!(
        mockContext,
        '--voice qwen3-asr-flash',
      );
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('qwen3-asr-flash'),
      });
    });

    it('should reject fastOnly models from --voice selection', async () => {
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model --voice fast-model',
          name: 'model',
          args: '--voice fast-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAllConfiguredModels: vi.fn().mockReturnValue([
              { id: 'main-model', label: 'Main' },
              { id: 'fast-model', label: 'Fast', fastOnly: true },
            ]),
          },
          settings: createMockSettings(),
        },
      });

      const result = await modelCommand.action!(
        mockContext,
        '--voice fast-model',
      );
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('fast-model'),
      });
    });

    it('should reject fastOnly models from --vision selection', async () => {
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model --vision fast-model',
          name: 'model',
          args: '--vision fast-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAllConfiguredModels: vi.fn().mockReturnValue([
              { id: 'main-model', label: 'Main' },
              { id: 'fast-model', label: 'Fast', fastOnly: true },
            ]),
            setVisionModel: vi.fn(),
          },
          settings: createMockSettings(),
        },
      });

      const result = await modelCommand.action!(
        mockContext,
        '--vision fast-model',
      );
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('fast-model'),
      });
    });

    it('should reject voiceOnly models from --vision selection', async () => {
      mockContext = createMockCommandContext({
        invocation: {
          raw: '/model --vision voice-model',
          name: 'model',
          args: '--vision voice-model',
        },
        services: {
          config: {
            getContentGeneratorConfig: vi.fn().mockReturnValue({
              model: 'main-model',
              authType: AuthType.USE_OPENAI,
            }),
            getAllConfiguredModels: vi.fn().mockReturnValue([
              { id: 'main-model', label: 'Main' },
              { id: 'voice-model', label: 'Voice', voiceOnly: true },
            ]),
            setVisionModel: vi.fn(),
          },
          settings: createMockSettings(),
        },
      });

      const result = await modelCommand.action!(
        mockContext,
        '--vision voice-model',
      );
      expect(result).toMatchObject({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('voice-model'),
      });
    });
  });

  describe('scope flags', () => {
    function setupContext() {
      const mockConfig = createMockConfig({
        model: 'test-model',
        authType: AuthType.USE_OPENAI,
      });
      (
        mockConfig as Partial<Config> & { [key: string]: unknown }
      ).getAvailableModelsForAuthType = vi.fn().mockReturnValue([]);
      (
        mockConfig as Partial<Config> & { [key: string]: unknown }
      ).getAllConfiguredModels = vi.fn().mockReturnValue([]);
      mockContext.services.config = mockConfig as Config;
      return mockContext;
    }

    it('should include persistScope in dialog return for /model --project', async () => {
      const ctx = setupContext();
      const result = await modelCommand.action!(ctx, '--project');
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'model',
        persistScope: 'workspace',
      });
    });

    it('should include persistScope in dialog return for /model --global', async () => {
      const ctx = setupContext();
      const result = await modelCommand.action!(ctx, '--global');
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'model',
        persistScope: 'user',
      });
    });

    it('should include persistScope for /model --project --fast dialog', async () => {
      const ctx = setupContext();
      const result = await modelCommand.action!(ctx, '--project --fast');
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'fast-model',
        persistScope: 'workspace',
      });
    });

    it('should include persistScope for /model --global --voice dialog', async () => {
      const ctx = setupContext();
      const result = await modelCommand.action!(ctx, '--global --voice');
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'voice-model',
        persistScope: 'user',
      });
    });

    it('should include persistScope for /model --project --vision dialog', async () => {
      const ctx = setupContext();
      const result = await modelCommand.action!(ctx, '--project --vision');
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'vision-model',
        persistScope: 'workspace',
      });
    });

    it('should parse scope flags in any position', async () => {
      const ctx = setupContext();
      const result = await modelCommand.action!(ctx, '--fast --project');
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'fast-model',
        persistScope: 'workspace',
      });
    });

    it('should show scope suffix in fast model confirmation', async () => {
      const setValue = vi.fn();
      const settings = {
        ...createMockSettings(setValue),
        _merged: {},
        computeMergedSettings: vi.fn(),
      } as unknown as LoadedSettings;
      const ctx = setupContext();
      ctx.services.settings = settings;
      const cfg = ctx.services.config as unknown as Partial<Config> & {
        [key: string]: unknown;
      };
      cfg.getAllConfiguredModels = vi
        .fn()
        .mockReturnValue([
          { id: 'qwen3-coder-flash', voiceOnly: false, fastOnly: true },
        ]);
      cfg.setFastModel = vi.fn();
      const result = await modelCommand.action!(
        ctx,
        '--project --fast qwen3-coder-flash',
      );
      expect(result).toMatchObject({
        type: 'message',
        content: expect.stringContaining('(project)'),
      });
    });

    it('should show scope suffix in main model confirmation', async () => {
      const setValue = vi.fn();
      const settings = {
        ...createMockSettings(setValue),
        _merged: {},
        computeMergedSettings: vi.fn(),
      } as unknown as LoadedSettings;
      const mockGenerator = {
        authType: AuthType.USE_OPENAI,
        model: 'qwen-max',
      };
      const ctx = setupContext();
      ctx.services.settings = settings;
      const cfg = ctx.services.config as unknown as Partial<Config> & {
        [key: string]: unknown;
      };
      cfg.getAvailableModelsForAuthType = vi
        .fn()
        .mockReturnValue([
          { id: 'qwen-max', voiceOnly: false, fastOnly: false },
        ]);
      cfg.switchModel = vi.fn().mockResolvedValue(mockGenerator);
      const result = await modelCommand.action!(ctx, '--project qwen-max');
      expect(result).toMatchObject({
        type: 'message',
        content: expect.stringContaining('(project)'),
      });
    });

    it('should not include persistScope when no scope flag is given', async () => {
      const ctx = setupContext();
      const result = await modelCommand.action!(ctx, '');
      expect(result).toEqual({
        type: 'dialog',
        dialog: 'model',
      });
    });
  });
});
