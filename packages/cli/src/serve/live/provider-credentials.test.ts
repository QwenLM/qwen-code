/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Settings } from '../../config/settings.js';
import {
  DEFAULT_LIVE_ENDPOINT,
  DEFAULT_LIVE_PROVIDER_MODEL,
  DEFAULT_LIVE_VOICE,
  DEFAULT_LIVE_VOICE_MODEL,
  LiveProviderConfigError,
  readLiveVoiceConfiguration,
  resolveLiveProviderCredential,
} from './provider-credentials.js';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    general: {
      liveVoice: {
        enabled: true,
      },
    },
    model: {
      name: 'unrelated-selected-model',
      baseUrl: 'https://unrelated.example/v1',
    },
    modelProviders: {
      openai: [
        {
          id: 'qwen3.8-max-preview',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY_PRE',
        },
      ],
    },
    env: { DASHSCOPE_API_KEY_PRE: 'settings-secret' },
    ...overrides,
  } as Settings;
}

describe('Live provider credentials', () => {
  it('applies the documented Live defaults', () => {
    expect(readLiveVoiceConfiguration({} as Settings)).toEqual({
      enabled: false,
      model: DEFAULT_LIVE_VOICE_MODEL,
      providerModel: DEFAULT_LIVE_PROVIDER_MODEL,
      endpoint: DEFAULT_LIVE_ENDPOINT,
      voice: DEFAULT_LIVE_VOICE,
    });
  });

  it('resolves the explicit provider entry and settings.env credential', () => {
    const resolved = resolveLiveProviderCredential(settings(), { env: {} });

    expect(resolved).toMatchObject({
      providerId: 'openai',
      authType: 'openai',
      modelId: 'qwen3.8-max-preview',
      envKey: 'DASHSCOPE_API_KEY_PRE',
      realtimeModel: DEFAULT_LIVE_VOICE_MODEL,
    });
    expect(resolved.apiKey).toBe('settings-secret');
    expect(JSON.stringify(resolved)).not.toContain('settings-secret');
    expect(Object.keys(resolved)).not.toContain('apiKey');
  });

  it('uses the effective daemon environment before settings.env', () => {
    const resolved = resolveLiveProviderCredential(settings(), {
      env: { DASHSCOPE_API_KEY_PRE: 'runtime-secret' },
    });

    expect(resolved.apiKey).toBe('runtime-secret');
    expect(JSON.stringify(resolved)).not.toContain('runtime-secret');
  });

  it('does not consult the selected chat model', () => {
    const resolved = resolveLiveProviderCredential(settings(), { env: {} });
    expect(resolved.modelId).toBe('qwen3.8-max-preview');
    expect(resolved.baseUrl).not.toContain('unrelated.example');
  });

  it('supports custom provider ids mapped to an explicit protocol', () => {
    const resolved = resolveLiveProviderCredential(
      settings({
        providerProtocol: { bailian: 'openai' },
        modelProviders: {
          bailian: [
            {
              id: 'qwen3.8-max-preview',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'BAILIAN_KEY',
            },
          ],
        },
        env: { BAILIAN_KEY: 'custom-secret' },
      }),
      { env: {} },
    );

    expect(resolved.providerId).toBe('bailian');
    expect(resolved.authType).toBe('openai');
    expect(resolved.apiKey).toBe('custom-secret');
  });

  it('fails closed for an ambiguous provider selector', () => {
    expect(() =>
      resolveLiveProviderCredential(
        settings({
          modelProviders: {
            openai: [
              {
                id: 'qwen3.8-max-preview',
                baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'KEY_A',
              },
              {
                id: 'qwen3.8-max-preview',
                baseUrl:
                  'https://other.dashscope.aliyuncs.com/compatible-mode/v1',
                envKey: 'KEY_B',
              },
            ],
          },
          env: { KEY_A: 'a', KEY_B: 'b' },
        }),
        { env: {} },
      ),
    ).toThrow(/ambiguous/);
  });

  it.each([
    [
      'plaintext provider',
      {
        baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
        endpoint: DEFAULT_LIVE_ENDPOINT,
      },
    ],
    [
      'foreign provider',
      {
        baseUrl: 'https://example.com/v1',
        endpoint: DEFAULT_LIVE_ENDPOINT,
      },
    ],
    [
      'plaintext realtime endpoint',
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        endpoint: 'ws://dashscope.aliyuncs.com/api-ws/v1/realtime',
      },
    ],
    [
      'credential-bearing provider URL',
      {
        baseUrl:
          'https://dashscope.aliyuncs.com/compatible-mode/v1?api_key=secret',
        endpoint: DEFAULT_LIVE_ENDPOINT,
      },
    ],
    [
      'credential-bearing realtime URL',
      {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        endpoint:
          'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?token=secret',
      },
    ],
  ])('rejects %s', (_name, values) => {
    const input = settings({
      general: {
        liveVoice: {
          enabled: true,
          endpoint: values.endpoint,
        },
      },
      modelProviders: {
        openai: [
          {
            id: 'qwen3.8-max-preview',
            baseUrl: values.baseUrl,
            envKey: 'DASHSCOPE_API_KEY_PRE',
          },
        ],
      },
    });

    expect(() => resolveLiveProviderCredential(input, { env: {} })).toThrow(
      LiveProviderConfigError,
    );
  });

  it('reports the env key but never the missing secret value', () => {
    const input = settings({ env: {} });
    expect(() => resolveLiveProviderCredential(input, { env: {} })).toThrow(
      /DASHSCOPE_API_KEY_PRE/,
    );
  });
});
