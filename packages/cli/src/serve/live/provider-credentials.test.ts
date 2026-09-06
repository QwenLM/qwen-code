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
  LiveProviderConfigError,
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
});
