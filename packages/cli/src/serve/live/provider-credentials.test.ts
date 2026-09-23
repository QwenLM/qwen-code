/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Settings } from '../../config/settings.js';
import {
  DEFAULT_LIVE_ENDPOINT,
  DEFAULT_LIVE_SHORTCUT,
  DEFAULT_LIVE_VOICE,
  DEFAULT_LIVE_VOICE_MODEL,
  findLiveRealtimeRoute,
  listLiveRealtimeRoutes,
  LiveProviderConfigError,
  normalizeLiveRealtimeEndpoint,
  readLiveVoiceConfiguration,
  resolveLiveProviderCredential,
} from './provider-credentials.js';

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    experimental: {
      liveVoice: {
        enabled: true,
        apiKey: 'settings-secret',
      },
    },
    ...overrides,
  } as Settings;
}

describe('Live provider credentials', () => {
  it('applies the documented Live defaults', () => {
    expect(readLiveVoiceConfiguration({} as Settings)).toEqual({
      enabled: false,
      model: DEFAULT_LIVE_VOICE_MODEL,
      endpoint: DEFAULT_LIVE_ENDPOINT,
      voice: DEFAULT_LIVE_VOICE,
      shortcut: DEFAULT_LIVE_SHORTCUT,
    });
    expect(DEFAULT_LIVE_SHORTCUT).toBe('Command+E');
  });

  it('preserves an empty shortcut as Off', () => {
    expect(
      readLiveVoiceConfiguration({
        experimental: { liveVoice: { shortcut: '' } },
      } as Settings).shortcut,
    ).toBe('');
  });

  it('resolves the dedicated Realtime credential', () => {
    const resolved = resolveLiveProviderCredential(settings());

    expect(resolved).toMatchObject({
      realtimeModel: DEFAULT_LIVE_VOICE_MODEL,
      endpoint: DEFAULT_LIVE_ENDPOINT,
    });
    expect(resolved.apiKey).toBe('settings-secret');
    expect(JSON.stringify(resolved)).not.toContain('settings-secret');
    expect(Object.keys(resolved)).not.toContain('apiKey');
  });

  it('accepts a one-shot key override while validating enablement', () => {
    const resolved = resolveLiveProviderCredential(
      settings({ experimental: { liveVoice: { enabled: false } } }),
      {
        apiKey: 'candidate-secret',
        allowDisabled: true,
      },
    );

    expect(resolved.apiKey).toBe('candidate-secret');
    expect(JSON.stringify(resolved)).not.toContain('candidate-secret');
  });

  it('does not consult the selected chat model or provider entries', () => {
    const resolved = resolveLiveProviderCredential(
      settings({
        model: {
          name: 'unrelated-selected-model',
          baseUrl: 'https://unrelated.example/v1',
        },
        modelProviders: {},
      }),
    );

    expect(resolved.realtimeModel).toBe(DEFAULT_LIVE_VOICE_MODEL);
    expect(JSON.stringify(resolved)).not.toContain('unrelated.example');
  });

  it('requires the dedicated key instead of a chat-provider env key', () => {
    const input = settings({
      experimental: { liveVoice: { enabled: true, apiKey: '' } },
      env: { DASHSCOPE_API_KEY: 'chat-secret' },
    });

    expect(() => resolveLiveProviderCredential(input)).toThrow(
      /not configured/,
    );
  });

  it.each([
    [
      'plaintext realtime endpoint',
      'ws://dashscope.aliyuncs.com/api-ws/v1/realtime',
    ],
    [
      'credential-bearing realtime URL',
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?token=secret',
    ],
    ['foreign realtime endpoint', 'wss://example.com/realtime'],
  ])('rejects %s', (_name, endpoint) => {
    const input = settings({
      experimental: {
        liveVoice: {
          enabled: true,
          apiKey: 'settings-secret',
          endpoint,
        },
      },
    });

    expect(() => resolveLiveProviderCredential(input)).toThrow(
      LiveProviderConfigError,
    );
  });

  it('does not expose a missing or configured secret in errors', () => {
    const input = settings({
      experimental: { liveVoice: { enabled: true, apiKey: '' } },
    });
    expect(() => resolveLiveProviderCredential(input)).toThrow(
      /not configured/,
    );
  });

  describe('realtimeOnly routes', () => {
    const route = {
      id: 'qwen3.5-omni-plus-realtime',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      envKey: 'DASHSCOPE_API_KEY',
      realtimeOnly: true,
    };

    function routed(
      liveVoice: Record<string, unknown> = {},
      providers: Record<string, unknown[]> = { openai: [route] },
      extra: Partial<Settings> = {},
    ): Settings {
      return {
        experimental: {
          liveVoice: { enabled: true, model: route.id, ...liveVoice },
        },
        modelProviders: providers,
        ...extra,
      } as unknown as Settings;
    }

    it('takes the endpoint from baseUrl and the key from envKey', () => {
      const credential = resolveLiveProviderCredential(routed(), {
        env: { DASHSCOPE_API_KEY: ' env-secret ' },
      });
      expect(credential).toEqual({
        endpoint: DEFAULT_LIVE_ENDPOINT,
        realtimeModel: route.id,
        voice: DEFAULT_LIVE_VOICE,
      });
      expect(credential.apiKey).toBe('env-secret');
    });

    it('prefers the route over the free-standing endpoint and key', () => {
      const credential = resolveLiveProviderCredential(
        routed(
          {
            apiKey: 'legacy-secret',
            endpoint: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
          },
          undefined,
        ),
        { env: { DASHSCOPE_API_KEY: 'env-secret' } },
      );
      expect(credential.endpoint).toBe(DEFAULT_LIVE_ENDPOINT);
      expect(credential.apiKey).toBe('env-secret');
    });

    it('never reads the process environment on its own', () => {
      const previous = process.env['DASHSCOPE_API_KEY'];
      process.env['DASHSCOPE_API_KEY'] = 'ambient-secret';
      try {
        // No `env` passed: the ambient variable must not be picked up.
        expect(() => resolveLiveProviderCredential(routed())).toThrow(
          /requires DASHSCOPE_API_KEY/,
        );
      } finally {
        if (previous === undefined) delete process.env['DASHSCOPE_API_KEY'];
        else process.env['DASHSCOPE_API_KEY'] = previous;
      }
    });

    it('falls back to the settings env block for the key', () => {
      const credential = resolveLiveProviderCredential(
        routed({}, undefined, {
          env: { DASHSCOPE_API_KEY: 'settings-env-secret' },
        } as Partial<Settings>),
        { env: {} },
      );
      expect(credential.apiKey).toBe('settings-env-secret');
    });

    it('names the missing variable instead of using the legacy key', () => {
      expect(() =>
        resolveLiveProviderCredential(routed({ apiKey: 'legacy-secret' }), {
          env: {},
        }),
      ).toThrow(/requires DASHSCOPE_API_KEY/);
    });

    it('does not read an envKey that names an Object.prototype member', () => {
      expect(() =>
        resolveLiveProviderCredential(
          routed({}, { openai: [{ ...route, envKey: 'constructor' }] }),
          { env: {} },
        ),
      ).toThrow(/requires constructor/);
    });

    it('keeps the DashScope allow-list for a derived endpoint', () => {
      expect(() =>
        resolveLiveProviderCredential(
          routed(
            {},
            {
              openai: [{ ...route, baseUrl: 'https://gateway.example.com/v1' }],
            },
          ),
          { env: { DASHSCOPE_API_KEY: 'env-secret' } },
        ),
      ).toThrow(/supported secure DashScope WebSocket endpoint/);
      // http would derive ws://, which the allow-list also refuses.
      expect(() =>
        resolveLiveProviderCredential(
          routed(
            {},
            {
              openai: [
                {
                  ...route,
                  baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
                },
              ],
            },
          ),
          { env: { DASHSCOPE_API_KEY: 'env-secret' } },
        ),
      ).toThrow(LiveProviderConfigError);
    });

    it('requires baseUrl and envKey on the route', () => {
      expect(() =>
        resolveLiveProviderCredential(
          routed({}, { openai: [{ id: route.id, realtimeOnly: true }] }),
          { env: {} },
        ),
      ).toThrow(/must declare baseUrl and envKey/);
    });

    it('ignores a same-id entry that is not realtimeOnly', () => {
      const input = routed(
        { apiKey: 'legacy-secret' },
        { openai: [{ ...route, realtimeOnly: undefined }] },
      );
      expect(listLiveRealtimeRoutes(input)).toEqual([]);
      // Falls through to the unchanged free-standing path.
      expect(resolveLiveProviderCredential(input, { env: {} }).apiKey).toBe(
        'legacy-secret',
      );
    });

    it('fails a provider-qualified selector that names no route instead of falling back', () => {
      // Route deleted / flag dropped / typo: the stored legacy key and
      // endpoint must not be picked up silently.
      const input = routed(
        { model: `openai:${route.id}`, apiKey: 'legacy-secret' },
        { openai: [{ ...route, realtimeOnly: undefined }] },
      );
      expect(() => resolveLiveProviderCredential(input, { env: {} })).toThrow(
        /names no realtimeOnly route under modelProviders\.openai/,
      );
    });

    it('keeps treating an id that merely contains a colon as a bare id', () => {
      const credential = resolveLiveProviderCredential(
        routed({ model: 'vendor:custom-realtime', apiKey: 'legacy-secret' }),
        { env: {} },
      );
      expect(credential.realtimeModel).toBe('vendor:custom-realtime');
      expect(credential.apiKey).toBe('legacy-secret');
    });

    it('says the route was not found when the free-standing key is missing', () => {
      expect(() =>
        resolveLiveProviderCredential(routed({ model: 'mistyped-id' }), {
          env: { DASHSCOPE_API_KEY: 'env-secret' },
        }),
      ).toThrow(/'mistyped-id' matches no realtimeOnly route/);
    });

    it('resolves provider:modelId and refuses an ambiguous bare id', () => {
      const input = routed(
        {},
        {
          openai: [route],
          'dashscope-intl': [
            {
              ...route,
              baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
            },
          ],
        },
      );
      expect(() => findLiveRealtimeRoute(input, route.id)).toThrow(
        /more than one realtimeOnly route/,
      );
      expect(
        findLiveRealtimeRoute(input, `dashscope-intl:${route.id}`),
      ).toMatchObject({ provider: 'dashscope-intl' });
      const credential = resolveLiveProviderCredential(
        routed(
          { model: `dashscope-intl:${route.id}` },
          input.modelProviders as never,
        ),
        { env: { DASHSCOPE_API_KEY: 'env-secret' } },
      );
      expect(credential.endpoint).toBe(
        'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
      );
      // The upstream sees the bare model id, not the selector.
      expect(credential.realtimeModel).toBe(route.id);
    });
  });

  describe('normalizeLiveRealtimeEndpoint', () => {
    it.each([
      [
        'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
        'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
      ],
      [
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
        'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime',
      ],
      [
        '  https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/  ',
        'wss://llm-abc.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
      ],
      [
        'https://dashscope.aliyuncs.com/api-ws/v1/realtime',
        'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
      ],
    ])('accepts %s', (input, expected) => {
      expect(normalizeLiveRealtimeEndpoint(input)).toBe(expected);
    });

    it.each([
      'not a url',
      'wss://example.com/api-ws/v1/realtime',
      'https://example.com/compatible-mode/v1',
      'http://dashscope.aliyuncs.com/compatible-mode/v1',
      'ws://dashscope.aliyuncs.com/api-ws/v1/realtime',
      'https://dashscope.aliyuncs.com/compatible-mode/v1?api_key=secret',
      'https://user:pass@dashscope.aliyuncs.com/compatible-mode/v1',
    ])('refuses %s', (input) => {
      expect(() => normalizeLiveRealtimeEndpoint(input)).toThrow(
        LiveProviderConfigError,
      );
    });
  });
});
