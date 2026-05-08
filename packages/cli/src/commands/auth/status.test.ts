/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showAuthStatus } from './handler.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  CODING_PLAN_ENV_KEY,
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_GLOBAL_BASE_URL,
  codingPlanProvider,
} from '../../auth/providers/alibaba/codingPlan.js';
import { buildProviderTemplate } from '../../auth/providerConfig.js';
import type { LoadedSettings } from '../../config/settings.js';

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

import { loadSettings } from '../../config/settings.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';

const codingPlanProviders = (baseUrl: string = CODING_PLAN_CHINA_BASE_URL) => ({
  [AuthType.USE_OPENAI]: buildProviderTemplate(codingPlanProvider, baseUrl),
});

describe('showAuthStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    delete process.env[CODING_PLAN_ENV_KEY];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env[CODING_PLAN_ENV_KEY];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['OPENROUTER_API_KEY'];
  });

  const createMockSettings = (
    merged: Record<string, unknown>,
  ): LoadedSettings =>
    ({
      merged,
      system: { settings: {}, path: '/system.json' },
      systemDefaults: { settings: {}, path: '/system-defaults.json' },
      user: { settings: {}, path: '/user.json' },
      workspace: { settings: {}, path: '/workspace.json' },
      forScope: vi.fn(),
      setValue: vi.fn(),
      isTrusted: true,
    }) as unknown as LoadedSettings;

  it('should show message when no authentication is configured', async () => {
    vi.mocked(loadSettings).mockReturnValue(createMockSettings({}));

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('No authentication method configured'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen auth openrouter'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen auth qwen-oauth'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen auth coding-plan'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('should show Qwen OAuth status when configured', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.QWEN_OAUTH,
          },
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Qwen OAuth'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Free tier (discontinued 2026-04-15)'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('No longer available'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('should show Coding Plan status when configured with API key', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        providerMetadata: {
          'coding-plan': {
            baseUrl: CODING_PLAN_CHINA_BASE_URL,
            version: 'abc123def456',
          },
        },
        model: {
          name: 'qwen3.5-plus',
        },
        modelProviders: codingPlanProviders(),
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Coding Plan'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('API key configured'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('should show OpenRouter status when configured with API key', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-openrouter-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        model: {
          name: 'openai/gpt-4o-mini',
        },
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'openai/gpt-4o-mini',
              name: 'OpenRouter · GPT-4o mini',
              baseUrl: 'https://openrouter.ai/api/v1',
              envKey: 'OPENROUTER_API_KEY',
            },
          ],
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('OpenRouter'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('openai/gpt-4o-mini'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('API key configured'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('should show OpenRouter as incomplete when API key is missing', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'openai/gpt-4o-mini',
              name: 'OpenRouter · GPT-4o mini',
              baseUrl: 'https://openrouter.ai/api/v1',
              envKey: 'OPENROUTER_API_KEY',
            },
          ],
        },
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('OpenRouter (Incomplete)'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen auth openrouter'),
    );
  });

  it('should show Coding Plan as incomplete when API key is missing', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        providerMetadata: {
          'coding-plan': {
            baseUrl: CODING_PLAN_GLOBAL_BASE_URL,
          },
        },
        modelProviders: codingPlanProviders(CODING_PLAN_GLOBAL_BASE_URL),
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Incomplete'),
    );
    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('API key not found'),
    );
  });

  it('should show Coding Plan base URL for China endpoint', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        providerMetadata: {
          'coding-plan': {
            baseUrl: CODING_PLAN_CHINA_BASE_URL,
          },
        },
        model: {
          name: 'qwen3.5-plus',
        },
        modelProviders: codingPlanProviders(),
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(CODING_PLAN_CHINA_BASE_URL),
    );
  });

  it('should show Coding Plan base URL for global endpoint', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        providerMetadata: {
          'coding-plan': {
            baseUrl: CODING_PLAN_GLOBAL_BASE_URL,
          },
        },
        model: {
          name: 'qwen3-coder-plus',
        },
        modelProviders: codingPlanProviders(CODING_PLAN_GLOBAL_BASE_URL),
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(CODING_PLAN_GLOBAL_BASE_URL),
    );
  });

  it('should show current model name', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        providerMetadata: {
          'coding-plan': {
            baseUrl: CODING_PLAN_CHINA_BASE_URL,
          },
        },
        model: {
          name: 'qwen3.5-plus',
        },
        modelProviders: codingPlanProviders(),
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('qwen3.5-plus'),
    );
  });

  it('should show config version (truncated)', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'test-api-key';

    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        security: {
          auth: {
            selectedType: AuthType.USE_OPENAI,
          },
        },
        providerMetadata: {
          'coding-plan': {
            baseUrl: CODING_PLAN_CHINA_BASE_URL,
            version: 'abc123def456789',
          },
        },
        model: {
          name: 'qwen3.5-plus',
        },
        modelProviders: codingPlanProviders(),
      }),
    );

    await showAuthStatus();

    expect(writeStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('abc123de...'),
    );
  });

  it('should handle errors and exit with code 1', async () => {
    const error = new Error('Settings load failed');
    vi.mocked(loadSettings).mockImplementation(() => {
      throw error;
    });

    await showAuthStatus();

    expect(writeStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to check authentication status'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  describe('OpenAI-compatible provider (no Coding Plan)', () => {
    afterEach(() => {
      delete process.env['OPENAI_API_KEY'];
      delete process.env['CUSTOM_API_KEY'];
      delete process.env['XUNFEI_API_KEY'];
      delete process.env[CODING_PLAN_ENV_KEY];
    });

    it('should show OpenAI-compatible status with OPENAI_API_KEY', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
          model: {
            name: 'gpt-4o',
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('gpt-4o'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key configured'),
      );
      expect(writeStdoutLine).not.toHaveBeenCalledWith(
        expect.stringContaining('Alibaba Cloud Coding Plan'),
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should show OpenAI-compatible status with custom envKey from modelProviders', async () => {
      process.env['CUSTOM_API_KEY'] = 'test-key';

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
          model: {
            name: 'custom-model',
          },
          modelProviders: {
            openai: [
              {
                id: 'custom-model',
                envKey: 'CUSTOM_API_KEY',
                baseUrl: 'https://custom-api.example.com/v1',
              },
            ],
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('custom-model'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('https://custom-api.example.com/v1'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key configured'),
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should show OpenAI-compatible status with settings.security.auth.apiKey', async () => {
      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
              apiKey: 'settings-api-key',
              baseUrl: 'https://my-provider.example.com/v1',
            },
          },
          model: {
            name: 'my-model',
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('https://my-provider.example.com/v1'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key configured'),
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should show incomplete when no API key is found for OpenAI-compatible provider', async () => {
      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider (Incomplete)'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key not found'),
      );
      expect(writeStdoutLine).not.toHaveBeenCalledWith(
        expect.stringContaining('Alibaba Cloud Coding Plan'),
      );
    });

    it('should detect API key via default model when model.name is unset', async () => {
      process.env['CUSTOM_API_KEY'] = 'test-key';

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
          modelProviders: {
            openai: [
              {
                id: 'default-model',
                envKey: 'CUSTOM_API_KEY',
                baseUrl: 'https://default-api.example.com/v1',
              },
            ],
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('https://default-api.example.com/v1'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key configured'),
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should show Incomplete when explicit envKey is missing even if OPENAI_API_KEY is set', async () => {
      process.env['OPENAI_API_KEY'] = 'fallback-key';

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
          model: {
            name: 'custom-model',
          },
          modelProviders: {
            openai: [
              {
                id: 'custom-model',
                envKey: 'CUSTOM_API_KEY',
                baseUrl: 'https://custom-api.example.com/v1',
              },
            ],
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider (Incomplete)'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key not found'),
      );
    });

    it('should not bind to unrelated provider entry when model.name does not match', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
          model: {
            name: 'manual-model-not-in-providers',
          },
          modelProviders: {
            openai: [
              {
                id: 'other-model',
                envKey: 'OTHER_API_KEY',
                baseUrl: 'https://other-api.example.com/v1',
              },
            ],
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key configured'),
      );
      // Should NOT show the unrelated provider's base URL
      expect(writeStdoutLine).not.toHaveBeenCalledWith(
        expect.stringContaining('https://other-api.example.com/v1'),
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should show OpenAI-compatible when stale codingPlan.region exists but active model is generic', async () => {
      process.env['XUNFEI_API_KEY'] = 'active-key';

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
          codingPlan: {
            region: 'china',
            version: 'stale-version',
          },
          model: {
            name: 'spark-v4',
          },
          modelProviders: {
            openai: [
              {
                id: 'spark-v4',
                envKey: 'XUNFEI_API_KEY',
                baseUrl: 'https://spark-api-open.xf-yun.com/v1',
              },
            ],
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key configured'),
      );
      expect(writeStdoutLine).not.toHaveBeenCalledWith(
        expect.stringContaining('Alibaba Cloud Coding Plan'),
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('should show OpenAI-compatible when stale Coding Plan key exists but active model is generic', async () => {
      process.env[CODING_PLAN_ENV_KEY] = 'stale-coding-plan-key';
      process.env['XUNFEI_API_KEY'] = 'active-key';

      vi.mocked(loadSettings).mockReturnValue(
        createMockSettings({
          security: {
            auth: {
              selectedType: AuthType.USE_OPENAI,
            },
          },
          model: {
            name: 'spark-v4',
          },
          modelProviders: {
            openai: [
              {
                id: 'spark-v4',
                envKey: 'XUNFEI_API_KEY',
                baseUrl: 'https://spark-api-open.xf-yun.com/v1',
              },
            ],
          },
        }),
      );

      await showAuthStatus();

      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('OpenAI-compatible Provider'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('spark-v4'),
      );
      expect(writeStdoutLine).toHaveBeenCalledWith(
        expect.stringContaining('API key configured'),
      );
      expect(writeStdoutLine).not.toHaveBeenCalledWith(
        expect.stringContaining('Alibaba Cloud Coding Plan'),
      );
      expect(process.exit).toHaveBeenCalledWith(0);
    });
  });
});
