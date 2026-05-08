/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { vi } from 'vitest';
import { validateAuthMethod } from './auth.js';
import * as settings from './settings.js';

vi.mock('./settings.js', () => ({
  loadEnvironment: vi.fn(),
  loadSettings: vi.fn().mockReturnValue({
    merged: {},
  }),
}));

describe('validateAuthMethod', () => {
  beforeEach(() => {
    vi.resetModules();
    // Reset mock to default
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {},
    } as ReturnType<typeof settings.loadSettings>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env['OPENAI_API_KEY'];
    delete process.env['CUSTOM_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY_ALTERED'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['GOOGLE_API_KEY'];
  });

  it('should return null for USE_OPENAI with default env key', () => {
    process.env['OPENAI_API_KEY'] = 'fake-key';
    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
  });

  it('should return an error message for USE_OPENAI if no API key is available', () => {
    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBe(
      "Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the 'OPENAI_API_KEY' environment variable.",
    );
  });

  it('should return null for USE_OPENAI with custom envKey from modelProviders', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);
    process.env['CUSTOM_API_KEY'] = 'custom-key';

    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
  });

  it('should return error with custom envKey hint when modelProviders envKey is set but env var is missing', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const result = validateAuthMethod(AuthType.USE_OPENAI);
    expect(result).toContain('CUSTOM_API_KEY');
  });

  it('should return null for USE_GEMINI with custom envKey', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'gemini-1.5-flash' },
        modelProviders: {
          gemini: [
            { id: 'gemini-1.5-flash', envKey: 'GEMINI_API_KEY_ALTERED' },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);
    process.env['GEMINI_API_KEY_ALTERED'] = 'altered-key';

    expect(validateAuthMethod(AuthType.USE_GEMINI)).toBeNull();
  });

  it('should return error with custom envKey for USE_GEMINI when env var is missing', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'gemini-1.5-flash' },
        modelProviders: {
          gemini: [
            { id: 'gemini-1.5-flash', envKey: 'GEMINI_API_KEY_ALTERED' },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const result = validateAuthMethod(AuthType.USE_GEMINI);
    expect(result).toContain('GEMINI_API_KEY_ALTERED');
  });

  it('should return an error for QWEN_OAUTH (free tier discontinued)', () => {
    const result = validateAuthMethod(AuthType.QWEN_OAUTH);
    expect(result).toContain('discontinued on 2026-04-15');
  });

  it('should return an error message for an invalid auth method', () => {
    expect(validateAuthMethod('invalid-method')).toBe(
      'Invalid auth method selected.',
    );
  });

  it('should return null for USE_ANTHROPIC with custom envKey and baseUrl', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'claude-3' },
        modelProviders: {
          anthropic: [
            {
              id: 'claude-3',
              envKey: 'CUSTOM_ANTHROPIC_KEY',
              baseUrl: 'https://api.anthropic.com',
            },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);
    process.env['CUSTOM_ANTHROPIC_KEY'] = 'custom-anthropic-key';

    expect(validateAuthMethod(AuthType.USE_ANTHROPIC)).toBeNull();
  });

  it('should return error for USE_ANTHROPIC when baseUrl is missing', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'claude-3' },
        modelProviders: {
          anthropic: [{ id: 'claude-3', envKey: 'CUSTOM_ANTHROPIC_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);
    process.env['CUSTOM_ANTHROPIC_KEY'] = 'custom-key';

    const result = validateAuthMethod(AuthType.USE_ANTHROPIC);
    expect(result).toContain('modelProviders[].baseUrl');
  });

  it('should return null for USE_VERTEX_AI with custom envKey', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'vertex-model' },
        modelProviders: {
          'vertex-ai': [
            { id: 'vertex-model', envKey: 'GOOGLE_API_KEY_VERTEX' },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);
    process.env['GOOGLE_API_KEY_VERTEX'] = 'vertex-key';

    expect(validateAuthMethod(AuthType.USE_VERTEX_AI)).toBeNull();
  });

  it('should use config.getModelsConfig().getModel() when Config is provided', () => {
    // Settings has a different model
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'settings-model' },
        modelProviders: {
          openai: [
            { id: 'settings-model', envKey: 'SETTINGS_API_KEY' },
            { id: 'cli-model', envKey: 'CLI_API_KEY' },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    // Mock Config object that returns a different model (e.g., from CLI args)
    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('cli-model'),
        getGenerationConfig: vi.fn().mockReturnValue({}),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    // Set the env key for the CLI model, not the settings model
    process.env['CLI_API_KEY'] = 'cli-key';

    // Should use 'cli-model' from config.getModelsConfig().getModel(), not 'settings-model'
    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
    expect(mockConfig.getModelsConfig).toHaveBeenCalled();
  });

  it('should fail validation when Config provides different model without matching env key', () => {
    // Clean up any existing env keys first
    delete process.env['CLI_API_KEY'];
    delete process.env['SETTINGS_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'settings-model' },
        modelProviders: {
          openai: [
            { id: 'settings-model', envKey: 'SETTINGS_API_KEY' },
            { id: 'cli-model', envKey: 'CLI_API_KEY' },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('cli-model'),
        getGenerationConfig: vi.fn().mockReturnValue({}),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    // Don't set CLI_API_KEY - validation should fail
    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('CLI_API_KEY');
  });

  // Regression test for #3171: validation must accept the API key resolved
  // into generationConfig.apiKey (e.g. from --openai-api-key) instead of
  // requiring an OPENAI_API_KEY env var.
  it('should accept API key resolved into generationConfig from CLI flag', () => {
    delete process.env['OPENAI_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {},
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('gpt-4'),
        getGenerationConfig: vi
          .fn()
          .mockReturnValue({ apiKey: 'cli-provided-key' }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
  });

  // Regression test for #3171: when a modelProvider has a custom envKey but
  // the user passes --openai-api-key on the CLI, the resolver picks the CLI
  // value. Validation should match the resolver and accept it instead of
  // demanding the env var.
  it('should accept CLI-resolved key even when modelProvider declares a custom envKey', () => {
    delete process.env['CUSTOM_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('custom-model'),
        getGenerationConfig: vi
          .fn()
          .mockReturnValue({ apiKey: 'cli-provided-key' }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
  });

  it('should accept runtime-resolved settings key when modelProvider declares a custom envKey', () => {
    delete process.env['CUSTOM_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        security: { auth: { apiKey: 'settings-fallback-key' } },
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('custom-model'),
        getGenerationConfig: vi
          .fn()
          .mockReturnValue({ apiKey: 'settings-fallback-key' }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
  });

  it('should keep no-config validation strict for missing custom envKey', () => {
    delete process.env['CUSTOM_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        security: { auth: { apiKey: 'settings-fallback-key' } },
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const result = validateAuthMethod(AuthType.USE_OPENAI);
    expect(result).toContain('CUSTOM_API_KEY');
  });
});
