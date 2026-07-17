/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AuthType,
  type Config,
  type ResolvedModelConfig,
} from '@qwen-code/qwen-code-core';
import {
  getFollowupSuggestionFeatureDecision,
  getFollowupSuggestionProviderConfig,
  isFollowupSuggestionSettingConfigured,
  shouldEnableFollowupSuggestions,
} from './followup-suggestions.js';

function settingsFile(settings: {
  ui?: { enableFollowupSuggestions?: boolean };
}) {
  return {
    settings,
    originalSettings: settings,
    path: '',
  };
}

describe('shouldEnableFollowupSuggestions', () => {
  it('honors an explicit opt-out', () => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: false,
          configured: true,
        },
        {
          authType: AuthType.QWEN_OAUTH,
        },
      ),
    ).toBe(false);
  });

  it('treats an unconfigured true value as the default', () => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: true,
          configured: false,
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'http://localhost:8080/v1',
        },
      ),
    ).toBe(false);
  });

  it('keeps explicit opt-in on loopback OpenAI-compatible providers', () => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: true,
          configured: true,
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'http://127.0.0.1:8080/v1',
        },
      ),
    ).toBe(true);
  });

  it.each([
    'http://localhost:8080/v1',
    'http://localhost.:8080/v1',
    'localhost:8080/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.0.1.1:8080/v1',
    'http://127.255.255.255:8080/v1',
    'http://0.0.0.0:8080/v1',
    'http://[::]:8080/v1',
    'http://[::1]:8080/v1',
    'http://[::ffff:0:0]:8080/v1',
    'http://[::ffff:127.0.0.1]:8080/v1',
    'http://[::ffff:7f00:1]:8080/v1',
  ])('defaults off for loopback OpenAI-compatible providers: %s', (baseUrl) => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl,
        },
      ),
    ).toBe(false);
  });

  it('defaults on for non-loopback OpenAI-compatible providers', () => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.openai.com/v1',
        },
      ),
    ).toBe(true);
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'http://[::ffff:8000:1]:8080/v1',
        },
      ),
    ).toBe(true);
  });

  it('defaults on for non-OpenAI providers', () => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        {
          authType: AuthType.QWEN_OAUTH,
        },
      ),
    ).toBe(true);
  });

  it('defaults on when the provider config is not initialized yet', () => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        undefined,
      ),
    ).toBe(true);
  });

  it('defaults on when the base URL is missing or malformed', () => {
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        {
          authType: AuthType.USE_OPENAI,
        },
      ),
    ).toBe(true);
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'not a url',
        },
      ),
    ).toBe(true);
  });
});

describe('isFollowupSuggestionSettingConfigured', () => {
  it('treats system defaults as explicit configuration', () => {
    expect(
      isFollowupSuggestionSettingConfigured({
        systemDefaults: settingsFile({
          ui: {
            enableFollowupSuggestions: true,
          },
        }),
      }),
    ).toBe(true);
  });

  it('ignores untrusted workspace settings', () => {
    expect(
      isFollowupSuggestionSettingConfigured({
        isTrusted: false,
        workspace: settingsFile({
          ui: {
            enableFollowupSuggestions: true,
          },
        }),
      }),
    ).toBe(false);
  });

  it.each(['user', 'system'] as const)(
    'treats %s settings as explicit configuration',
    (scope) => {
      expect(
        isFollowupSuggestionSettingConfigured({
          [scope]: settingsFile({
            ui: {
              enableFollowupSuggestions: true,
            },
          }),
        }),
      ).toBe(true);
    },
  );

  it('treats trusted workspace settings as explicit configuration', () => {
    expect(
      isFollowupSuggestionSettingConfigured({
        isTrusted: true,
        workspace: settingsFile({
          ui: {
            enableFollowupSuggestions: false,
          },
        }),
      }),
    ).toBe(true);
  });

  it('returns false when no setting layer configures follow-up suggestions', () => {
    expect(isFollowupSuggestionSettingConfigured({})).toBe(false);
  });
});

describe('getFollowupSuggestionProviderConfig', () => {
  it('uses the primary provider when no fast model is configured', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-primary',
      }),
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('returns undefined when provider config is not initialized yet', () => {
    expect(getFollowupSuggestionProviderConfig({})).toBeUndefined();
  });

  it('falls back to the models config generation config when the content generator config is missing', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getModelsConfig: () =>
        ({
          getGenerationConfig: () => ({
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://localhost:11434/v1',
            model: 'local-primary',
          }),
        }) as unknown as ReturnType<Config['getModelsConfig']>,
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('uses the fast model provider because suggestions run on the fast model', () => {
    const fastModel = {
      authType: AuthType.USE_OPENAI,
      id: 'local-fast',
      name: 'local-fast',
      baseUrl: 'http://localhost:11434/v1',
      generationConfig: {},
      capabilities: {},
    } satisfies ResolvedModelConfig;

    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.QWEN_OAUTH,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-coder-plus',
      }),
      getFastModel: () => `${AuthType.USE_OPENAI}:local-fast`,
      getModel: () => 'qwen3-coder-plus',
      getAllConfiguredModels: () => [
        {
          authType: AuthType.USE_OPENAI,
          id: 'local-fast',
          label: 'local-fast',
        },
      ],
      getModelsConfig: () =>
        ({
          getResolvedModel: (authType: AuthType, modelId: string) =>
            authType === AuthType.USE_OPENAI && modelId === 'local-fast'
              ? fastModel
              : undefined,
        }) as unknown as ReturnType<Config['getModelsConfig']>,
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        providerConfig,
      ),
    ).toBe(false);
  });

  it('carries the base URL from an unresolved cross-auth fast model option', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.QWEN_OAUTH,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3-coder-plus',
      }),
      getFastModel: () => `${AuthType.USE_OPENAI}:runtime-local-fast`,
      getModel: () => 'qwen3-coder-plus',
      getAllConfiguredModels: () => [
        {
          authType: AuthType.USE_OPENAI,
          id: 'runtime-local-fast',
          label: 'runtime-local-fast',
          isRuntimeModel: true,
          runtimeSnapshotId: '$runtime|openai|runtime-local-fast',
        },
      ],
      getActiveRuntimeModelSnapshot: () => ({
        id: '$runtime|openai|runtime-local-fast',
        authType: AuthType.USE_OPENAI,
        modelId: 'runtime-local-fast',
        baseUrl: 'http://localhost:11434/v1',
        sources: {},
        createdAt: 0,
      }),
      getModelsConfig: () =>
        ({
          getResolvedModel: () => undefined,
        }) as unknown as ReturnType<Config['getModelsConfig']>,
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        providerConfig,
      ),
    ).toBe(false);
  });

  it('carries the base URL from an unresolved same-auth fast model option', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://api.example.com/v1',
        model: 'cloud-primary',
      }),
      getFastModel: () => `${AuthType.USE_OPENAI}:runtime-local-fast`,
      getModel: () => 'cloud-primary',
      getAllConfiguredModels: () => [
        {
          authType: AuthType.USE_OPENAI,
          id: 'runtime-local-fast',
          label: 'runtime-local-fast',
          isRuntimeModel: true,
          runtimeSnapshotId: '$runtime|openai|runtime-local-fast',
        },
      ],
      getActiveRuntimeModelSnapshot: () => ({
        id: '$runtime|openai|runtime-local-fast',
        authType: AuthType.USE_OPENAI,
        modelId: 'runtime-local-fast',
        baseUrl: 'http://localhost:11434/v1',
        sources: {},
        createdAt: 0,
      }),
      getModelsConfig: () =>
        ({
          getResolvedModel: () => undefined,
        }) as unknown as ReturnType<Config['getModelsConfig']>,
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        providerConfig,
      ),
    ).toBe(false);
  });

  it('falls back to the primary provider when fast model resolution throws', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-primary',
      }),
      getFastModel: () => `${AuthType.USE_OPENAI}:`,
      getModel: () => 'local-primary',
      getAllConfiguredModels: () => [],
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('falls back to the primary provider for same-auth fast models without a base URL', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-primary',
      }),
      getFastModel: () => `${AuthType.USE_OPENAI}:local-fast`,
      getModel: () => 'local-primary',
      getAllConfiguredModels: () => [
        {
          authType: AuthType.USE_OPENAI,
          id: 'local-fast',
          label: 'local-fast',
        },
      ],
      getModelsConfig: () =>
        ({
          getResolvedModel: () => undefined,
        }) as unknown as ReturnType<Config['getModelsConfig']>,
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('falls back to the primary provider when a runtime snapshot ID is stale', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-primary',
      }),
      getFastModel: () => `${AuthType.USE_OPENAI}:local-fast`,
      getModel: () => 'local-primary',
      getAllConfiguredModels: () => [
        {
          authType: AuthType.USE_OPENAI,
          id: 'local-fast',
          label: 'local-fast',
          isRuntimeModel: true,
          runtimeSnapshotId: '$runtime|openai|old-local-fast',
        },
      ],
      getActiveRuntimeModelSnapshot: () => ({
        id: '$runtime|openai|new-local-fast',
        authType: AuthType.USE_OPENAI,
        modelId: 'local-fast',
        baseUrl: 'http://localhost:11435/v1',
        sources: {},
        createdAt: 0,
      }),
      getModelsConfig: () =>
        ({
          getResolvedModel: () => undefined,
        }) as unknown as ReturnType<Config['getModelsConfig']>,
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('falls back to the primary provider for unresolvable cross-auth fast models', () => {
    const providerConfig = getFollowupSuggestionProviderConfig({
      getContentGeneratorConfig: () => ({
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:11434/v1',
        model: 'local-primary',
      }),
      getFastModel: () => `${AuthType.QWEN_OAUTH}:missing-fast`,
      getModel: () => 'local-primary',
      getAllConfiguredModels: () => [],
      getModelsConfig: () =>
        ({
          getResolvedModel: () => undefined,
        }) as unknown as ReturnType<Config['getModelsConfig']>,
    });

    expect(providerConfig).toEqual({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(
      shouldEnableFollowupSuggestions(
        {
          value: undefined,
          configured: false,
        },
        providerConfig,
      ),
    ).toBe(false);
  });
});

describe('getFollowupSuggestionFeatureDecision', () => {
  it('reports when the loopback default suppresses follow-up suggestions', () => {
    expect(
      getFollowupSuggestionFeatureDecision(
        {
          merged: {
            ui: {},
          },
        } as Parameters<typeof getFollowupSuggestionFeatureDecision>[0],
        {
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://localhost:11434/v1',
            model: 'local-primary',
          }),
        },
      ),
    ).toEqual({
      enabled: false,
      suppressedReason: 'loopback_openai_default',
    });
  });

  it('does not report loopback suppression for an explicit opt-in', () => {
    expect(
      getFollowupSuggestionFeatureDecision(
        {
          merged: {
            ui: {
              enableFollowupSuggestions: true,
            },
          },
          user: settingsFile({
            ui: {
              enableFollowupSuggestions: true,
            },
          }),
        } as Parameters<typeof getFollowupSuggestionFeatureDecision>[0],
        {
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://localhost:11434/v1',
            model: 'local-primary',
          }),
        },
      ),
    ).toEqual({
      enabled: true,
      suppressedReason: undefined,
    });
  });

  it('defaults on for non-loopback providers when unset', () => {
    expect(
      getFollowupSuggestionFeatureDecision(
        {
          merged: {
            ui: {},
          },
        } as Parameters<typeof getFollowupSuggestionFeatureDecision>[0],
        {
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://api.openai.com/v1',
            model: 'remote-primary',
          }),
        },
      ),
    ).toEqual({
      enabled: true,
      suppressedReason: undefined,
    });
  });

  it('honors explicit opt-out without reporting loopback suppression', () => {
    expect(
      getFollowupSuggestionFeatureDecision(
        {
          merged: {
            ui: {
              enableFollowupSuggestions: false,
            },
          },
          user: settingsFile({
            ui: {
              enableFollowupSuggestions: false,
            },
          }),
        } as Parameters<typeof getFollowupSuggestionFeatureDecision>[0],
        {
          getContentGeneratorConfig: () => ({
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://localhost:11434/v1',
            model: 'local-primary',
          }),
        },
      ),
    ).toEqual({
      enabled: false,
      suppressedReason: undefined,
    });
  });
});
