/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveModelConfig,
  validateModelConfig,
} from './modelConfigResolver.js';
import { AuthType } from '../core/contentGenerator.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';

describe('modelConfigResolver', () => {
  describe('resolveModelConfig', () => {
    describe('OpenAI auth type', () => {
      it('resolves from CLI with highest priority', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {
            model: 'cli-model',
            apiKey: 'cli-key',
            baseUrl: 'https://cli.example.com',
          },
          settings: {
            model: 'settings-model',
            apiKey: 'settings-key',
            baseUrl: 'https://settings.example.com',
          },
          env: {
            OPENAI_MODEL: 'env-model',
            OPENAI_API_KEY: 'env-key',
            OPENAI_BASE_URL: 'https://env.example.com',
          },
        });

        expect(result.config.model).toBe('cli-model');
        expect(result.config.apiKey).toBe('cli-key');
        expect(result.config.baseUrl).toBe('https://cli.example.com');

        expect(result.sources['model'].kind).toBe('cli');
        expect(result.sources['apiKey'].kind).toBe('cli');
        expect(result.sources['baseUrl'].kind).toBe('cli');
      });

      it('falls back to env when CLI not provided', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            model: 'settings-model',
          },
          env: {
            OPENAI_MODEL: 'env-model',
            OPENAI_API_KEY: 'env-key',
          },
        });

        expect(result.config.model).toBe('env-model');
        expect(result.config.apiKey).toBe('env-key');

        expect(result.sources['model'].kind).toBe('env');
        expect(result.sources['apiKey'].kind).toBe('env');
      });

      it('falls back to settings when env not provided', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            model: 'settings-model',
            apiKey: 'settings-key',
            baseUrl: 'https://settings.example.com',
          },
          env: {},
        });

        expect(result.config.model).toBe('settings-model');
        expect(result.config.apiKey).toBe('settings-key');
        expect(result.config.baseUrl).toBe('https://settings.example.com');

        expect(result.sources['model'].kind).toBe('settings');
        expect(result.sources['apiKey'].kind).toBe('settings');
        expect(result.sources['baseUrl'].kind).toBe('settings');
      });

      it('uses default model when nothing provided', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            OPENAI_API_KEY: 'some-key', // need key to be valid
          },
        });

        expect(result.config.model).toBe('qwen3-coder-plus');
        expect(result.sources['model'].kind).toBe('default');
      });

      it('prioritizes modelProvider over CLI', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {
            model: 'cli-model',
          },
          settings: {},
          env: {
            MY_CUSTOM_KEY: 'provider-key',
          },
          modelProvider: {
            id: 'provider-model',
            name: 'Provider Model',
            authType: AuthType.USE_OPENAI,
            envKey: 'MY_CUSTOM_KEY',
            baseUrl: 'https://provider.example.com',
            generationConfig: {},
            capabilities: {},
          },
        });

        expect(result.config.model).toBe('provider-model');
        expect(result.config.apiKey).toBe('provider-key');
        expect(result.config.baseUrl).toBe('https://provider.example.com');

        expect(result.sources['model'].kind).toBe('modelProviders');
        expect(result.sources['apiKey'].kind).toBe('env');
        expect(result.sources['apiKey'].via?.kind).toBe('modelProviders');
      });

      it('reads QWEN_MODEL as fallback for OPENAI_MODEL', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            QWEN_MODEL: 'qwen-model',
            OPENAI_API_KEY: 'key',
          },
        });

        expect(result.config.model).toBe('qwen-model');
        expect(result.sources['model'].envKey).toBe('QWEN_MODEL');
      });
    });

    describe('Qwen OAuth auth type', () => {
      it('uses default model for Qwen OAuth', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {},
        });

        expect(result.config.model).toBe(DEFAULT_QWEN_MODEL);
        expect(result.config.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
        expect(result.sources['apiKey'].kind).toBe('computed');
      });

      it('allows vision-model for Qwen OAuth', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {
            model: 'vision-model',
          },
          settings: {},
          env: {},
        });

        expect(result.config.model).toBe('vision-model');
        expect(result.sources['model'].kind).toBe('cli');
      });

      it('warns and falls back for unsupported Qwen OAuth models', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {
            model: 'unsupported-model',
          },
          settings: {},
          env: {},
        });

        expect(result.config.model).toBe(DEFAULT_QWEN_MODEL);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('unsupported-model');
      });
    });

    describe('Anthropic auth type', () => {
      it('resolves Anthropic config from env', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_ANTHROPIC,
          cli: {},
          settings: {},
          env: {
            ANTHROPIC_API_KEY: 'anthropic-key',
            ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
            ANTHROPIC_MODEL: 'claude-3',
          },
        });

        expect(result.config.model).toBe('claude-3');
        expect(result.config.apiKey).toBe('anthropic-key');
        expect(result.config.baseUrl).toBe('https://anthropic.example.com');
      });
    });

    describe('generation config resolution', () => {
      it('merges generation config from settings', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 60000,
              maxRetries: 5,
              samplingParams: {
                temperature: 0.7,
              },
            },
          },
          env: {},
        });

        expect(result.config.timeout).toBe(60000);
        expect(result.config.maxRetries).toBe(5);
        expect(result.config.samplingParams?.temperature).toBe(0.7);

        expect(result.sources['timeout'].kind).toBe('settings');
        expect(result.sources['samplingParams'].kind).toBe('settings');
      });

      it('modelProvider config overrides settings', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            MY_KEY: 'key',
          },
          modelProvider: {
            id: 'model',
            name: 'Model',
            authType: AuthType.USE_OPENAI,
            envKey: 'MY_KEY',
            baseUrl: 'https://api.example.com',
            generationConfig: {
              timeout: 60000,
            },
            capabilities: {},
          },
        });

        expect(result.config.timeout).toBe(60000);
        expect(result.sources['timeout'].kind).toBe('modelProviders');
      });
    });

    describe('proxy handling', () => {
      it('includes proxy in config when provided', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: { apiKey: 'key' },
          env: {},
          proxy: 'http://proxy.example.com:8080',
        });

        expect(result.config.proxy).toBe('http://proxy.example.com:8080');
        expect(result.sources['proxy'].kind).toBe('computed');
      });
    });
  });

  describe('validateModelConfig', () => {
    it('passes for valid OpenAI config', () => {
      const result = validateModelConfig({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
        apiKey: 'sk-xxx',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when API key missing', () => {
      const result = validateModelConfig({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Missing API key');
    });

    it('fails when model missing', () => {
      const result = validateModelConfig({
        authType: AuthType.USE_OPENAI,
        model: '',
        apiKey: 'sk-xxx',
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Missing model');
    });

    it('always passes for Qwen OAuth', () => {
      const result = validateModelConfig({
        authType: AuthType.QWEN_OAUTH,
        model: DEFAULT_QWEN_MODEL,
        apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
      });

      expect(result.valid).toBe(true);
    });

    it('requires baseUrl for Anthropic', () => {
      const result = validateModelConfig({
        authType: AuthType.USE_ANTHROPIC,
        model: 'claude-3',
        apiKey: 'key',
        // missing baseUrl
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('ANTHROPIC_BASE_URL');
    });

    it('uses strict error messages for modelProvider', () => {
      const result = validateModelConfig(
        {
          authType: AuthType.USE_OPENAI,
          model: 'my-model',
          // missing apiKey
        },
        true, // isStrictModelProvider
      );

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('modelProviders');
      expect(result.errors[0].message).toContain('envKey');
    });
  });
});
