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
      const settings = makeMockSettings({
        model: undefined as unknown as Settings['model'],
      });
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

    it('should use process.env (filtered) when env is not provided', () => {
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

      // process.env is filtered: model env vars stripped since model came from settings
      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.not.objectContaining({
            OPENAI_MODEL: expect.anything(),
            QWEN_MODEL: expect.anything(),
          }),
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

    // Case A: settings.model.name wins over OPENAI_MODEL when it matches a modelProvider
    it('Case A: should use settings.model.name for modelProvider lookup even when OPENAI_MODEL is set', () => {
      const argv = {};
      const settingsProvider: ProviderModelConfig = {
        id: 'settings-model',
        name: 'Settings Model',
        generationConfig: { samplingParams: { temperature: 0.9 } },
      };
      const envProvider: ProviderModelConfig = {
        id: 'env-model',
        name: 'Env Model',
        generationConfig: { samplingParams: { temperature: 0.5 } },
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [settingsProvider, envProvider],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'settings-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'env-model' },
      });

      // settings.model.name should win - modelProvider should be settingsProvider
      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: settingsProvider,
        }),
      );
    });

    // Case B: OPENAI_MODEL is honored when settings.model.name is not set
    it('Case B: should use OPENAI_MODEL when settings.model.name is not set', () => {
      const argv = {};
      const envProvider: ProviderModelConfig = {
        id: 'env-model',
        name: 'Env Model',
        generationConfig: { samplingParams: { temperature: 0.7 } },
      };
      const settings = makeMockSettings({
        model: undefined as unknown as Settings['model'],
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            { id: 'other-model', name: 'Other Model' },
            envProvider,
          ],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'env-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'env-model' },
      });

      // OPENAI_MODEL should be used since settings.model.name is not set
      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: envProvider,
        }),
      );
    });

    // Edge Case 1: argv.model overrides everything including settings.model.name and OPENAI_MODEL
    it('Edge Case 1: argv.model should override settings.model.name and OPENAI_MODEL', () => {
      const argv = { model: 'cli-model' };
      const cliProvider: ProviderModelConfig = {
        id: 'cli-model',
        name: 'CLI Model',
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            { id: 'settings-model', name: 'Settings Model' },
            { id: 'env-model', name: 'Env Model' },
            cliProvider,
          ],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'cli-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'env-model' },
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: cliProvider,
        }),
      );
    });

    // Edge Case 2: QWEN_MODEL is used as final fallback when OPENAI_MODEL is not set
    it('Edge Case 2: QWEN_MODEL should be used as fallback when OPENAI_MODEL is not set', () => {
      const argv = {};
      const qwenProvider: ProviderModelConfig = {
        id: 'qwen-env-model',
        name: 'Qwen Env Model',
      };
      const settings = makeMockSettings({
        model: undefined as unknown as Settings['model'],
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            { id: 'other-model', name: 'Other Model' },
            qwenProvider,
          ],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'qwen-env-model', apiKey: '', baseUrl: '' },
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
          modelProvider: qwenProvider,
        }),
      );
    });

    // Edge Case 3: OPENAI_MODEL over QWEN_MODEL when both are set and settings.model.name is not set
    it('Edge Case 3: OPENAI_MODEL should win over QWEN_MODEL when both set', () => {
      const argv = {};
      const openAIProvider: ProviderModelConfig = {
        id: 'openai-env-model',
        name: 'OpenAI Env Model',
      };
      const qwenProvider: ProviderModelConfig = {
        id: 'qwen-env-model',
        name: 'Qwen Env Model',
      };
      const settings = makeMockSettings({
        model: undefined as unknown as Settings['model'],
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            { id: 'other-model', name: 'Other Model' },
            openAIProvider,
            qwenProvider,
          ],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'openai-env-model', apiKey: '', baseUrl: '' },
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
          modelProvider: openAIProvider,
        }),
      );
    });

    // Edge Case 4: Non-OpenAI auth should ignore OPENAI_MODEL
    it('Edge Case 4: non-OpenAI auth should ignore OPENAI_MODEL', () => {
      const argv = {};
      const settingsProvider: ProviderModelConfig = {
        id: 'settings-model',
        name: 'Settings Model',
      };
      const settings = makeMockSettings({
        model: { name: 'settings-model' },
        modelProviders: {
          [AuthType.USE_ANTHROPIC]: [settingsProvider],
        },
      });
      const selectedAuthType = AuthType.USE_ANTHROPIC;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'settings-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'some-other-model' },
      });

      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: settingsProvider,
        }),
      );
    });

    // Edge Case 5: settings.model.name does NOT fall back to OPENAI_MODEL when unmatched
    it('Edge Case 5: settings.model.name should NOT fall back to OPENAI_MODEL when unmatched', () => {
      const argv = {};
      const envProvider: ProviderModelConfig = {
        id: 'env-model',
        name: 'Env Model',
      };
      const settings = makeMockSettings({
        model: { name: 'non-existent-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            { id: 'other-model', name: 'Other Model' },
            envProvider,
          ],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      vi.mocked(resolveModelConfig).mockReturnValue({
        config: { model: 'non-existent-model', apiKey: '', baseUrl: '' },
        sources: {},
        warnings: [],
      });

      resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'env-model' },
      });

      // settings.model.name takes precedence even when unmatched - no provider fallback
      expect(vi.mocked(resolveModelConfig)).toHaveBeenCalledWith(
        expect.objectContaining({
          modelProvider: undefined,
        }),
      );
    });

    // Integration test: settings.model.name unmatched + OPENAI_MODEL matched
    it('Integration: settings.model.name wins over OPENAI_MODEL even when unmatched', () => {
      const argv = {};
      const settings = makeMockSettings({
        model: { name: 'custom-model' },
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'gpt-4',
              name: 'GPT-4',
              generationConfig: { samplingParams: { temperature: 0.5 } },
            },
          ],
        },
      });
      const selectedAuthType = AuthType.USE_OPENAI;

      // Mock resolveModelConfig to simulate real behavior:
      // modelProvider.id > cli.model > env > settings.model
      vi.mocked(resolveModelConfig).mockImplementation((input) => {
        const model =
          input?.modelProvider?.id ||
          input?.cli?.model ||
          input?.env?.['OPENAI_MODEL'] ||
          input?.settings?.model ||
          '';
        return {
          config: { model, apiKey: '', baseUrl: '' },
          sources: {
            model:
              model === 'custom-model'
                ? { kind: 'settings' as const, path: 'model.name' }
                : { kind: 'env' as const, envKey: 'OPENAI_MODEL' },
          },
          warnings: [],
        };
      });

      const result = resolveCliGenerationConfig({
        argv,
        settings,
        selectedAuthType,
        env: { OPENAI_MODEL: 'gpt-4' },
      });

      // settings.model.name should be used (no provider found, so modelProvider is undefined)
      expect(result.model).toBe('custom-model');
    });

    describe('[Regression] model precedence', () => {
      it('[Regression] settings.model.name must NOT be overridden by OPENAI_MODEL', () => {
        // This is the core bug: settings.model.name (set via /model)
        // must take precedence over OPENAI_MODEL.
        const settings = makeMockSettings({
          model: { name: 'settings-model' },
        });
        const selectedAuthType = AuthType.USE_OPENAI;
        const env = { OPENAI_MODEL: 'env-model', OPENAI_API_KEY: 'key' };

        // Mock: settings.model.name should be used, not OPENAI_MODEL
        vi.mocked(resolveModelConfig).mockImplementation(() => ({
          config: { model: 'settings-model', apiKey: 'key', baseUrl: '' },
          sources: {
            model: { kind: 'settings' as const, path: 'model.name' },
          },
          warnings: [],
        }));

        const result = resolveCliGenerationConfig({
          argv: {},
          settings,
          selectedAuthType,
          env,
        });

        expect(result.model).toBe('settings-model');
        // Verify OPENAI_MODEL was filtered from env passed to resolveModelConfig
        const callArgs = vi.mocked(resolveModelConfig).mock.calls[0][0];
        expect(callArgs.env?.['OPENAI_MODEL']).toBeUndefined();
      });

      it('[Regression] OPENAI_MODEL used when settings.model.name not set', () => {
        const settings = makeMockSettings({ model: { name: undefined } });
        const selectedAuthType = AuthType.USE_OPENAI;
        const env = { OPENAI_MODEL: 'env-model', OPENAI_API_KEY: 'key' };

        vi.mocked(resolveModelConfig).mockImplementation(() => ({
          config: { model: 'env-model', apiKey: 'key', baseUrl: '' },
          sources: {
            model: { kind: 'env' as const, envKey: 'OPENAI_MODEL' },
          },
          warnings: [],
        }));

        resolveCliGenerationConfig({
          argv: {},
          settings,
          selectedAuthType,
          env,
        });

        // OPENAI_MODEL should NOT be filtered (it's the source of the model)
        const callArgs = vi.mocked(resolveModelConfig).mock.calls[0][0];
        expect(callArgs.env?.['OPENAI_MODEL']).toBe('env-model');
      });

      it('[Regression] argv.model overrides both settings and OPENAI_MODEL', () => {
        const argv = { model: 'argv-model' };
        const settings = makeMockSettings({
          model: { name: 'settings-model' },
        });
        const selectedAuthType = AuthType.USE_OPENAI;
        const env = { OPENAI_MODEL: 'env-model', OPENAI_API_KEY: 'key' };

        vi.mocked(resolveModelConfig).mockImplementation(() => ({
          config: { model: 'argv-model', apiKey: 'key', baseUrl: '' },
          sources: { model: { kind: 'cli' as const, detail: '--model' } },
          warnings: [],
        }));

        const result = resolveCliGenerationConfig({
          argv,
          settings,
          selectedAuthType,
          env,
        });

        expect(result.model).toBe('argv-model');
        // Both settings and env should be filtered when argv.model is set
        const callArgs = vi.mocked(resolveModelConfig).mock.calls[0][0];
        expect(callArgs.env?.['OPENAI_MODEL']).toBeUndefined();
      });

      it('[Regression] QWEN_MODEL as fallback when OPENAI_MODEL not set', () => {
        const settings = makeMockSettings({ model: { name: undefined } });
        const selectedAuthType = AuthType.USE_OPENAI;
        const env = { QWEN_MODEL: 'qwen-model', OPENAI_API_KEY: 'key' };

        vi.mocked(resolveModelConfig).mockImplementation(() => ({
          config: { model: 'qwen-model', apiKey: 'key', baseUrl: '' },
          sources: { model: { kind: 'env' as const, envKey: 'QWEN_MODEL' } },
          warnings: [],
        }));

        resolveCliGenerationConfig({
          argv: {},
          settings,
          selectedAuthType,
          env,
        });

        // QWEN_MODEL should be passed to resolveModelConfig
        const callArgs = vi.mocked(resolveModelConfig).mock.calls[0][0];
        expect(callArgs.env?.['QWEN_MODEL']).toBe('qwen-model');
      });

      it('[Regression] Non-OpenAI auth ignores OPENAI_MODEL', () => {
        const argv = {};
        const settings = makeMockSettings();
        const selectedAuthType = AuthType.USE_ANTHROPIC;
        const env = {
          OPENAI_MODEL: 'should-be-ignored',
          ANTHROPIC_API_KEY: 'key',
          ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        };

        vi.mocked(resolveModelConfig).mockImplementation(() => ({
          config: {
            model: 'claude-3',
            apiKey: 'key',
            baseUrl: 'https://api.anthropic.com',
          },
          sources: {
            model: { kind: 'env' as const, envKey: 'ANTHROPIC_MODEL' },
          },
          warnings: [],
        }));

        const result = resolveCliGenerationConfig({
          argv,
          settings,
          selectedAuthType,
          env,
        });

        // For non-OpenAI auth, OPENAI_MODEL should not be in the model resolution
        expect(result.model).toBe('claude-3');
        const callArgs = vi.mocked(resolveModelConfig).mock.calls[0][0];
        expect(callArgs.env?.['OPENAI_MODEL']).toBeUndefined();
      });
    });
  });
});
