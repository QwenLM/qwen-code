/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildProviderSettingsEntry,
  providerIdForPreset,
  ProviderPresetError,
} from './install.js';
import {
  customProviderPreset,
  qwencloudStandardPreset,
} from './presets.js';

describe('buildProviderSettingsEntry', () => {
  it('maps a preset into a settings.providers entry', () => {
    const entry = buildProviderSettingsEntry({
      preset: qwencloudStandardPreset,
      baseUrl: 'https://maas.qwencloudapi.com/compatible-mode/v1',
      apiKey: 'sk-test',
      modelIds: ['qwen3.8-max', 'custom-model'],
    });

    expect(entry.providerId).toBe('qwencloud-standard');
    expect(entry.value).toMatchObject({
      protocol: 'openai',
      baseUrl: 'https://maas.qwencloudapi.com/compatible-mode/v1',
      apiKey: 'sk-test',
      displayName: 'QwenCloud Standard',
    });
    expect(entry.value['models']).toEqual([
      {
        model: 'qwen3.8-max',
        contextWindow: 1_000_000,
        capabilities: {
          vision: true,
          thinking: {
            modes: ['enabled'],
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'xhigh'],
          },
        },
      },
      { model: 'custom-model' },
    ]);
  });

  it('rejects a key the preset does not accept', () => {
    expect(() =>
      buildProviderSettingsEntry({
        preset: qwencloudStandardPreset,
        apiKey: 'sk-sp-token-plan',
        modelIds: ['qwen3.8-max'],
      }),
    ).toThrow(ProviderPresetError);
  });

  it('gives custom providers a stable id derived from protocol and URL', () => {
    const first = providerIdForPreset(customProviderPreset, 'http://localhost:8000/v1');
    const second = providerIdForPreset(customProviderPreset, 'http://localhost:8000/v1/');
    const third = providerIdForPreset(customProviderPreset, 'http://localhost:9000/v1');
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toMatch(/^custom-[0-9a-f]{10}$/);
  });

  it('requires a base URL for the custom provider', () => {
    expect(() =>
      buildProviderSettingsEntry({
        preset: customProviderPreset,
        apiKey: 'key',
        modelIds: ['m'],
      }),
    ).toThrow(ProviderPresetError);
  });

  it.each([
    'htt://example.test/v1',
    'example.test/v1',
    'https://user:pass@example.test/v1',
    'https://example.test/v1?token=1',
    'https://example.test/v1#fragment',
  ])('rejects an invalid custom provider URL: %s', (baseUrl) => {
    expect(() =>
      buildProviderSettingsEntry({
        preset: customProviderPreset,
        baseUrl,
        apiKey: 'key',
        modelIds: ['m'],
      }),
    ).toThrow('baseUrl must be an http(s) URL');
  });

  it('normalizes a valid custom provider URL before persisting it', () => {
    const entry = buildProviderSettingsEntry({
      preset: customProviderPreset,
      baseUrl: ' https://example.test/v1/ ',
      apiKey: 'key',
      modelIds: ['m'],
    });
    expect(entry.value['baseUrl']).toBe('https://example.test/v1');
  });
});
