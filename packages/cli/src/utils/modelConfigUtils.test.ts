/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AuthType,
  resolveModelConfig,
  type ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from './modelConfigUtils.js';
import type { Settings } from '../config/settings.js';

const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    resolveModelConfig: vi.fn(),
  };
});

vi.mock('./stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: vi.fn(),
  clearScreen: vi.fn(),
}));

describe('modelConfigUtils', () => {
  describe('getAuthTypeFromEnv', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      // Start with a clean env - getAuthTypeFromEnv only checks auth-related vars
      process.env = {};
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should return USE_OPENAI when all OpenAI env vars are set', () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      process.env['OPENAI_MODEL'] = 'gpt-4';
      process.env['OPENAI_BASE_URL'] = 'https://api.openai.com';

      expect(getAuthTypeFromEnv()).toBe(AuthType.USE_OPENAI);
    });

    it('should return undefined when OpenAI env vars are incomplete', () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      process.env['OPENAI_MODEL'] = 'gpt-4';
      // Missing OPENAI_BASE_URL

      expect(getAuthTypeFromEnv()).toBeUndefined();
    });

    it('should return QWEN_OAUTH when QWEN_OAUTH is set', () => {
      process.env['QWEN_OAUTH'] = 'true';

      expect(getAuthTypeFromEnv()).toBe(AuthType.QWEN_OAUTH);
    });

    it('should return USE_GEMINI when Gemini env vars are set', () => {
      process.env['GEMINI_API_KEY'] = 'test-key';
      process.env['GEMINI_MODEL'] = 'gemini-pro';

      expect(getAuthTypeFromEnv()).toBe(AuthType.USE_GEMINI);
    });

    it('should return undefined when Gemini env vars are incomplete', () => {
      process.env['GEMINI_API_KEY'] = 'test-key';
      // Missing GEMINI_MODEL

      expect(getAuthTypeFromEnv()).toBeUndefined();
    });

    it('should return USE_VERTEX_AI when Google env vars are set', () => {
      process.env['GOOGLE_API_KEY'] = 'test-key';
      process.env['GOOGLE_MODEL'] = 'vertex-model';

      expect(getAuthTypeFromEnv()).toBe(AuthType.USE_VERTEX_AI);
    });

    it('should return undefined when Google env vars are incomplete', () => {
      process.env['GOOGLE_API_KEY'] = 'test-key';
      // Missing GOOGLE_MODEL

      expect(getAuthTypeFromEnv()).toBeUndefined();
    });

    it('should return USE_ANTHROPIC when Anthropic env vars are set', () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';
      process.env['ANTHROPIC_MODEL'] = 'claude-3';
      process.env['ANTHROPIC_BASE_URL'] = 'https://api.anthropic.com';

      expect(getAuthTypeFromEnv()).toBe(AuthType.USE_ANTHROPIC);
    });

    it('should return undefined when Anthropic env vars are incomplete', () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';
      process.env['ANTHROPIC_MODEL'] = 'claude-3';
      // Missing ANTHROPIC_BASE_URL

      expect(getAuthTypeFromEnv()).toBeUndefined();
    });

    it('should prioritize QWEN_OAUTH over other auth types when explicitly set', () => {
      process.env['QWEN_OAUTH'] = 'true';
      process.env['OPENAI_API_KEY'] = 'test-key';
      process.env['OPENAI_MODEL'] = 'gpt-4';
      process.env['OPENAI_BASE_URL'] = 'https://api.openai.com';

      // QWEN_OAUTH is checked first, so it should be returned even when other auth vars are set
      expect(getAuthTypeFromEnv()).toBe(AuthType.QWEN_OAUTH);
    });

    it('should return undefined when no auth env vars are set', () => {
      expect(getAuthTypeFromEnv()).toBeUndefined();
    });
  });

  describe('resolveCliGenerationConfig', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      vi.resetModules();
      process.env = { ...originalEnv };
      delete process.env['OPENAI_MODEL'];
      delete process.env['QWEN_MODEL'];
      mockWriteStderrLine.mockClear();
    });

    afterEach(() => {
      process.env = originalEnv;
      vi.clearAllMocks();
    });

    function makeMockSettings(overrides?: Partial<Settings>): Settings {
      return {
        model: { name: 'default-model' },
        security: {
          auth: {
            apiKey: 'settings-api-key',
            baseUrl: 'https://settings.example.com',
          },
        },
        ...overrides,
      } as Settings;
    }

    it('should resolve config from argv with highest precedence', () => {
      const argv = {
        model: 'argv-model',
        openaiApiKey: 'argv-key',
        openaiBaseUrl: 'https://argv.example.com',
      };
      const settings = makeMockSettings();
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'argv-model',
          apiKey: 'argv-key',
          baseUrl: 'https://argv.example.com',
        },
        sources: {
          model: { kind: 'cli', detail: '--model' },
          apiKey: { kind: 'cli', detail: '--openaiApiKey' },
          baseUrl: { kind: 'cli', detail: '--openaiBaseUrl' },
        },
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.model).toBe('argv-model');
      expect(result.apiKey).toBe('argv-key');
      expect(result.baseUrl).toBe('https://argv.example.com');
      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          cli: {
            model: 'argv-model',
            apiKey: 'argv-key',
            baseUrl: 'https://argv.example.com',
          },
        }),
      );
    });

    it('should resolve config from settings when argv is not provided', () => {
      const argv = {};
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        security: {
          auth: {
            apiKey: 'settings-key',
            baseUrl: 'https://settings.example.com',
          },
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'settings-model',
          apiKey: 'settings-key',
          baseUrl: 'https://settings.example.com',
        },
        sources: {
          model: { kind: 'settings', detail: 'model.name' },
          apiKey: { kind: 'settings', detail: 'security.auth.apiKey' },
          baseUrl: { kind: 'settings', detail: 'security.auth.baseUrl' },
        },
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.model).toBe('settings-model');
      expect(result.apiKey).toBe('settings-key');
      expect(result.baseUrl).toBe('https://settings.example.com');
    });

    it('should merge generationConfig from settings', () => {
      const argv = {};
      const settings = makeMockSettings({
        model: {
          name: 'test-model',
          generationConfig: {
            samplingParams: {
              temperature: 0.7,
              max_tokens: 1000,
            },
            timeout: 5000,
          } as Record<string, unknown>,
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
          samplingParams: {
            temperature: 0.7,
            max_tokens: 1000,
          },
          timeout: 5000,
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.generationConfig.samplingParams?.temperature).toBe(0.7);
      expect(result.generationConfig.samplingParams?.max_tokens).toBe(1000);
      expect(result.generationConfig.timeout).toBe(5000);
    });

    it('should resolve OpenAI logging from argv', () => {
      const argv = {
        openaiLogging: true,
        openaiLoggingDir: '/custom/log/dir',
      };
      const settings = makeMockSettings();
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.generationConfig.enableOpenAILogging).toBe(true);
      expect(result.generationConfig.openAILoggingDir).toBe('/custom/log/dir');
    });

    it('should resolve OpenAI logging from settings when argv is undefined', () => {
      const argv = {};
      const settings = makeMockSettings({
        model: {
          name: 'test-model',
          enableOpenAILogging: true,
          openAILoggingDir: '/settings/log/dir',
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.generationConfig.enableOpenAILogging).toBe(true);
      expect(result.generationConfig.openAILoggingDir).toBe(
        '/settings/log/dir',
      );
    });

    it('should default OpenAI logging to false when not provided', () => {
      const argv = {};
      const settings = makeMockSettings();
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.generationConfig.enableOpenAILogging).toBe(false);
    });

    it('should find modelProvider from settings when authType and model match', () => {
      const argv = { model: 'provider-model' };
      const modelProvider: ProviderModelConfig = {
        id: 'provider-model',
        name: 'Provider Model',
        generationConfig: {
          samplingParams: { temperature: 0.8 },
        },
      };
      const settings = makeMockSettings({
        modelProviders: {
          [AuthType.USE_OPENAI]: [modelProvider],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'provider-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider,
        }),
      );
    });

    it('should find modelProvider from settings.model.name when argv.model is not provided', () => {
      const argv = {};
      const modelProvider: ProviderModelConfig = {
        id: 'settings-model',
        name: 'Settings Model',
        generationConfig: {
          samplingParams: { temperature: 0.9 },
        },
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [modelProvider],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'settings-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider,
        }),
      );
    });

    it('should find modelProvider from settings.model.name when set (takes precedence over OPENAI_MODEL)', () => {
      const argv = {};
      const settingsProvider: ProviderModelConfig = {
        id: 'settings-model',
        name: 'Settings Model',
      };
      const envProvider: ProviderModelConfig = {
        id: 'env-openai-model',
        name: 'Env OpenAI Model',
        generationConfig: {
          samplingParams: { temperature: 0.6 },
        },
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [settingsProvider, envProvider],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'settings-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'env-openai-model' },
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: settingsProvider,
        }),
      );
    });

    it('should find modelProvider from settings.model.name when set (takes precedence over QWEN_MODEL)', () => {
      const argv = {};
      const settingsProvider: ProviderModelConfig = {
        id: 'settings-model',
        name: 'Settings Model',
      };
      const envProvider: ProviderModelConfig = {
        id: 'qwen-env-model',
        name: 'Qwen Env Model',
        generationConfig: {
          samplingParams: { temperature: 0.7 },
        },
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [settingsProvider, envProvider],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'settings-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { QWEN_MODEL: 'qwen-env-model' },
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: settingsProvider,
        }),
      );
    });

    it('should prefer settings.model.name over OPENAI_MODEL for USE_OPENAI provider lookup', () => {
      const argv = {};
      const settingsProvider: ProviderModelConfig = {
        id: 'settings-model',
        name: 'Settings Model',
      };
      const openAIProvider: ProviderModelConfig = {
        id: 'openai-env-model',
        name: 'OpenAI Env Model',
      };
      const qwenProvider: ProviderModelConfig = {
        id: 'qwen-env-model',
        name: 'Qwen Env Model',
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            settingsProvider,
            qwenProvider,
            openAIProvider,
          ],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'settings-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: {
          OPENAI_MODEL: 'openai-env-model',
          QWEN_MODEL: 'qwen-env-model',
        },
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: settingsProvider,
        }),
      );
    });

    it('should ignore OPENAI_MODEL for non-USE_OPENAI provider lookup', () => {
      const argv = {};
      const settingsModelProvider: ProviderModelConfig = {
        id: 'settings-model',
        name: 'Settings Model',
      };
      const unrelatedOpenAIProvider: ProviderModelConfig = {
        id: 'openai-env-model',
        name: 'OpenAI Env Model',
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_ANTHROPIC]: [
            settingsModelProvider,
            unrelatedOpenAIProvider,
          ],
        },
      });
      const selectedAuthType = AuthType.USE_ANTHROPIC;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'settings-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'openai-env-model' },
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: settingsModelProvider,
        }),
      );
    });
    it('should not find modelProvider when authType is undefined', () => {
      const argv = { model: 'test-model' };
      const settings = makeMockSettings({
        modelProviders: {
          [AuthType.USE_OPENAI]: [{ id: 'test-model', name: 'Test Model' }],
        },
      });
      const selectedAuthType = undefined;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: undefined,
        }),
      );
    });

    it('should not find modelProvider when modelProviders is not an array', () => {
      const argv = { model: 'test-model' };
      const settings = makeMockSettings({
        modelProviders: {
          [AuthType.USE_OPENAI]: null as unknown as ProviderModelConfig[],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: undefined,
        }),
      );
    });

    it('should return warnings from resolveModelConfig', () => {
      const argv = {};
      const settings = makeMockSettings();
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: ['Warning 1', 'Warning 2'],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.warnings).toEqual(['Warning 1', 'Warning 2']);
    });

    it('should use custom env when provided', () => {
      const argv = {};
      const settings = makeMockSettings();
      const selectedAuthType = AuthType.USE_OPENAI;
      const customEnv = {
        OPENAI_API_KEY: 'custom-key',
        OPENAI_MODEL: 'custom-model',
      };

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'custom-model',
          apiKey: 'custom-key',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: customEnv,
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          env: customEnv,
        }),
      );
    });

    it('should use process.env when env is not provided', () => {
      const argv = {};
      const settings = makeMockSettings();
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.any(Object),
        }),
      );
    });

    it('should return empty strings for missing model, apiKey, and baseUrl', () => {
      const argv = {};
      const settings = makeMockSettings();
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: '',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.model).toBe('');
      expect(result.apiKey).toBe('');
      expect(result.baseUrl).toBe('');
    });

    it('should merge resolved config with logging settings', () => {
      const argv = {
        openaiLogging: true,
      };
      const settings = makeMockSettings({
        model: {
          name: 'test-model',
          generationConfig: {
            timeout: 5000,
          } as Record<string, unknown>,
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'test-model',
          apiKey: 'test-key',
          baseUrl: 'https://test.com',
          samplingParams: { temperature: 0.5 },
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.generationConfig).toEqual({
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
        samplingParams: { temperature: 0.5 },
        enableOpenAILogging: true,
        openAILoggingDir: undefined,
      });
    });

    it('should handle settings without model property', () => {
      const argv = {};
      const settings = makeMockSettings({
        model: undefined as unknown as Settings['model'],
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: '',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(result.model).toBe('');
      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            model: undefined,
          }),
        }),
      );
    });

    it('should handle settings without security.auth property', () => {
      const argv = {};
      const settings = makeMockSettings({
        security: undefined,
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: '',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            apiKey: undefined,
            baseUrl: undefined,
          }),
        }),
      );
    });

    it('should respect precedence: argv.model > OPENAI_MODEL > QWEN_MODEL > settings.model.name', () => {
      const mockSettings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            { id: 'settings-model' } as ProviderModelConfig,
            { id: 'openai-env-model' } as ProviderModelConfig,
            { id: 'qwen-env-model' } as ProviderModelConfig,
            { id: 'cli-model' } as ProviderModelConfig,
          ],
        },
      });

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'cli-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });
      const result1 = resolveCliGenerationConfig({
        argv: { model: 'cli-model' },
        settings: mockSettings,
        selectedAuthType: AuthType.USE_OPENAI,
        env: { OPENAI_MODEL: 'openai-env-model' },
      });
      expect(result1.model).toBe('cli-model');

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'openai-env-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });
      const result2 = resolveCliGenerationConfig({
        argv: {},
        settings: mockSettings,
        selectedAuthType: AuthType.USE_OPENAI,
        env: { OPENAI_MODEL: 'openai-env-model', QWEN_MODEL: 'qwen-env-model' },
      });
      expect(result2.model).toBe('openai-env-model');

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'openai-env-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });
      const result3 = resolveCliGenerationConfig({
        argv: {},
        settings: mockSettings,
        selectedAuthType: AuthType.USE_OPENAI,
        env: { OPENAI_MODEL: 'openai-env-model' },
      });
      expect(result3.model).toBe('openai-env-model');

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'settings-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });
      const result4 = resolveCliGenerationConfig({
        argv: {},
        settings: mockSettings,
        selectedAuthType: AuthType.USE_OPENAI,
        env: {},
      });
      expect(result4.model).toBe('settings-model');
    });
    it('should not use env-matched provider when settings.model.name is set but unmatched', () => {
      // Regression: when settings.model.name is set but doesn't match any
      // provider, the code should NOT fall through to OPENAI_MODEL/QWEN_MODEL.
      // The env-matched provider should only supply metadata when no model is requested.
      const mockSettings = makeMockSettings({
        modelProviders: {
          [AuthType.USE_OPENAI]: [{ id: 'gpt-4' }],
        },
        model: { name: 'custom-model-not-in-providers' },
      });
      const selectedAuthType = AuthType.USE_OPENAI;
      process.env['OPENAI_MODEL'] = 'gpt-4';

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: {
          model: 'custom-model-not-in-providers',
          apiKey: '',
          baseUrl: '',
        },
        sources: {},
        warnings: [],
      });

      const result = resolveCliGenerationConfig({
        argv: {},
        settings: mockSettings,
        selectedAuthType,
      });

      // Should use settings.model.name, not fall through to OPENAI_MODEL
      expect(result.model).toBe('custom-model-not-in-providers');
      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: undefined, // No provider found for custom model
        }),
      );

      delete process.env['OPENAI_MODEL'];
    });
  });
});
