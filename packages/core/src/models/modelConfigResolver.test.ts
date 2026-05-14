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
import { DEFAULT_QWEN_MODEL, MAINLINE_CODER_MODEL } from '../config/models.js';

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

        expect(result.config.model).toBe(MAINLINE_CODER_MODEL);
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
            envKey: 'MY_CUSTOM_KEY',
            baseUrl: 'https://provider.example.com',
            generationConfig: {},
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

      it('allows coder-model for Qwen OAuth', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {
            model: 'coder-model',
          },
          settings: {},
          env: {},
        });

        expect(result.config.model).toBe('coder-model');
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

      it('QWEN_CODE_API_TIMEOUT_MS applies in Qwen OAuth path', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {
            QWEN_CODE_API_TIMEOUT_MS: '45000',
          },
        });

        expect(result.config.timeout).toBe(45000);
        expect(result.sources['timeout']).toBeDefined();
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );
        expect(result.config.model).toBe(DEFAULT_QWEN_MODEL);
      });

      it('modelProvider timeout takes precedence over QWEN_CODE_API_TIMEOUT_MS in OAuth', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {
            QWEN_CODE_API_TIMEOUT_MS: '45000',
          },
          modelProvider: {
            id: 'qwen-oauth',
            name: 'Qwen OAuth',
            generationConfig: {
              timeout: 120000,
            },
          },
        });

        expect(result.config.timeout).toBe(120000);
        expect(result.sources['timeout'].kind).toBe('modelProviders');
      });

      it('invalid QWEN_CODE_API_TIMEOUT_MS ignored in OAuth path', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {
            QWEN_CODE_API_TIMEOUT_MS: 'not-a-number',
          },
        });

        expect(result.config.timeout).toBeUndefined();
      });

      it('negative QWEN_CODE_API_TIMEOUT_MS ignored in OAuth path', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {
            QWEN_CODE_API_TIMEOUT_MS: '-100',
          },
        });

        expect(result.config.timeout).toBeUndefined();
      });

      it('zero QWEN_CODE_API_TIMEOUT_MS ignored in OAuth path', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {
            QWEN_CODE_API_TIMEOUT_MS: '0',
          },
        });

        expect(result.config.timeout).toBeUndefined();
      });

      it('QWEN_CODE_API_TIMEOUT_MS works with float value in OAuth', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {
            QWEN_CODE_API_TIMEOUT_MS: '12345.67',
          },
        });

        expect(result.config.timeout).toBe(12345);
      });

      it('QWEN_CODE_API_TIMEOUT_MS works with proxy in OAuth path', () => {
        const result = resolveModelConfig({
          authType: AuthType.QWEN_OAUTH,
          cli: {},
          settings: {},
          env: {
            QWEN_CODE_API_TIMEOUT_MS: '60000',
          },
          proxy: 'http://proxy.example.com:8080',
        });

        expect(result.config.timeout).toBe(60000);
        expect(result.config.proxy).toBe('http://proxy.example.com:8080');
        expect(result.sources['timeout'].kind).toBe('env');
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
            envKey: 'MY_KEY',
            baseUrl: 'https://api.example.com',
            generationConfig: {
              timeout: 60000,
            },
          },
        });

        expect(result.config.timeout).toBe(60000);
        expect(result.sources['timeout'].kind).toBe('modelProviders');
      });

      it('QWEN_CODE_API_TIMEOUT_MS env var overrides settings timeout', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
        });

        expect(result.config.timeout).toBe(900000);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );
      });

      it('modelProvider timeout wins over QWEN_CODE_API_TIMEOUT_MS', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            MY_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
          modelProvider: {
            id: 'model',
            name: 'Model',
            envKey: 'MY_KEY',
            baseUrl: 'https://api.example.com',
            generationConfig: {
              timeout: 60000,
            },
          },
        });

        // modelProvider > env: modelProvider timeout should win
        expect(result.config.timeout).toBe(60000);
        expect(result.sources['timeout'].kind).toBe('modelProviders');
      });

      it('QWEN_CODE_API_TIMEOUT_MS applies when modelProvider has no timeout', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            MY_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
          modelProvider: {
            id: 'model',
            name: 'Model',
            envKey: 'MY_KEY',
            baseUrl: 'https://api.example.com',
            generationConfig: {},
          },
        });

        expect(result.config.timeout).toBe(900000);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );
      });

      it('ignores invalid QWEN_CODE_API_TIMEOUT_MS values', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: 'invalid',
          },
        });

        // Should fall back to settings value
        expect(result.config.timeout).toBe(30000);
        expect(result.sources['timeout'].kind).toBe('settings');
      });

      it('ignores negative or zero QWEN_CODE_API_TIMEOUT_MS values', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '0',
          },
        });

        // Should fall back to settings value
        expect(result.config.timeout).toBe(30000);
        expect(result.sources['timeout'].kind).toBe('settings');
      });

      it('timeout is undefined when not configured, default applied in buildClient', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
          },
          env: {
            OPENAI_API_KEY: 'key',
          },
        });

        // timeout is undefined here; DEFAULT_TIMEOUT (120000) is applied in
        // the provider's buildClient() when timeout is not set.
        expect(result.config.timeout).toBeUndefined();
      });

      it('QWEN_CODE_API_TIMEOUT_MS works for Anthropic auth type', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_ANTHROPIC,
          cli: {},
          settings: {},
          env: {
            ANTHROPIC_API_KEY: 'key',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            QWEN_CODE_API_TIMEOUT_MS: '600000',
          },
        });

        expect(result.config.timeout).toBe(600000);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );
      });

      it('env var actually changes resolved timeout value', () => {
        // Integration-style test: proves the env var flows through to the resolved config
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
        });

        // Timeout should be the env var value, not the settings value
        expect(result.config.timeout).toBe(900000);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );

        // Prove it would be used by the client (default.ts:48 reads config.timeout)
        const clientTimeout = result.config.timeout;
        expect(clientTimeout).toBe(900000);
      });

      it('handles extremely large timeout values safely', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: { apiKey: 'key' },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '999999999',
          },
        });

        expect(result.config.timeout).toBe(999999999);
        expect(result.sources['timeout'].kind).toBe('env');
      });

      it('handles whitespace-padded env values', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: { apiKey: 'key' },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: ' 300000 ',
          },
        });

        // Number() implicitly trims whitespace, so this should parse correctly
        expect(result.config.timeout).toBe(300000);
        expect(result.sources['timeout'].kind).toBe('env');
      });

      it('ignores negative QWEN_CODE_API_TIMEOUT_MS values', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: { timeout: 30000 },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '-100',
          },
        });

        expect(result.config.timeout).toBe(30000);
        expect(result.sources['timeout'].kind).toBe('settings');
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

  describe('[Regression] timeout env override refactor', () => {
    it('[Regression] OAuth path must apply QWEN_CODE_API_TIMEOUT_MS (was broken before fix #3629)', () => {
      // Guards against the original bug where resolveQwenOAuthConfig()
      // returned before applying the env override.
      const result = resolveModelConfig({
        authType: AuthType.QWEN_OAUTH,
        cli: {},
        settings: {},
        env: {
          QWEN_CODE_API_TIMEOUT_MS: '45000',
        },
      });

      expect(result.config.timeout).toBe(45000);
      expect(result.sources['timeout']).toBeDefined();
      expect(result.sources['timeout'].kind).toBe('env');
      expect(result.sources['timeout'].envKey).toBe('QWEN_CODE_API_TIMEOUT_MS');
      expect(result.config.model).toBe(DEFAULT_QWEN_MODEL);
    });

    it('[Regression] non-OAuth path must apply QWEN_CODE_API_TIMEOUT_MS', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: { apiKey: 'key' },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '900000',
        },
      });

      expect(result.config.timeout).toBe(900000);
      expect(result.sources['timeout'].kind).toBe('env');
      expect(result.sources['timeout'].envKey).toBe('QWEN_CODE_API_TIMEOUT_MS');
    });

    it('[Regression] modelProvider timeout must win over env in both paths', () => {
      // Non-OAuth
      const nonOAuth = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {},
        env: {
          MY_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '900000',
        },
        modelProvider: {
          id: 'model',
          name: 'Model',
          envKey: 'MY_KEY',
          baseUrl: 'https://api.example.com',
          generationConfig: { timeout: 60000 },
        },
      });
      expect(nonOAuth.config.timeout).toBe(60000);
      expect(nonOAuth.sources['timeout'].kind).toBe('modelProviders');

      // OAuth
      const oauth = resolveModelConfig({
        authType: AuthType.QWEN_OAUTH,
        cli: {},
        settings: {},
        env: {
          QWEN_CODE_API_TIMEOUT_MS: '45000',
        },
        modelProvider: {
          id: 'qwen-oauth',
          name: 'Qwen OAuth',
          generationConfig: { timeout: 120000 },
        },
      });
      expect(oauth.config.timeout).toBe(120000);
      expect(oauth.sources['timeout'].kind).toBe('modelProviders');
    });

    it('[Regression] refactor must not alter precedence: env > settings', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {
          apiKey: 'key',
          generationConfig: { timeout: 30000 },
        },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '900000',
        },
      });

      // env must override settings
      expect(result.config.timeout).toBe(900000);
      expect(result.sources['timeout'].kind).toBe('env');
    });
  });

  describe('[Additional] timeout env override edge cases', () => {
    it('handles scientific notation in QWEN_CODE_API_TIMEOUT_MS', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: { apiKey: 'key' },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '1.5e5',
        },
      });

      expect(result.config.timeout).toBe(150000);
      expect(result.sources['timeout'].kind).toBe('env');
    });

    it('handles hex values in QWEN_CODE_API_TIMEOUT_MS', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: { apiKey: 'key', generationConfig: { timeout: 30000 } },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '0x2BF20', // 180000 in hex
        },
      });

      expect(result.config.timeout).toBe(180000);
      expect(result.sources['timeout'].kind).toBe('env');
    });

    it('ignores empty string QWEN_CODE_API_TIMEOUT_MS', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: { apiKey: 'key', generationConfig: { timeout: 30000 } },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '',
        },
      });

      expect(result.config.timeout).toBe(30000);
      expect(result.sources['timeout'].kind).toBe('settings');
    });

    it('applies env override for every supported auth type', () => {
      const authTypes = [
        { type: AuthType.USE_OPENAI, env: { OPENAI_API_KEY: 'key' } },
        {
          type: AuthType.USE_ANTHROPIC,
          env: {
            ANTHROPIC_API_KEY: 'key',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
          },
        },
      ];

      for (const { type, env } of authTypes) {
        const result = resolveModelConfig({
          authType: type,
          cli: {},
          settings: {
            ...(type === AuthType.USE_OPENAI ? { apiKey: 'key' } : {}),
          },
          env: { ...env, QWEN_CODE_API_TIMEOUT_MS: '99999' },
        });

        expect(result.config.timeout).toBe(99999);
        expect(result.sources['timeout'].kind).toBe('env');
      }
    });
  });
});
