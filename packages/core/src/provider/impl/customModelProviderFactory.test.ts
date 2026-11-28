/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsService } from '@qwen-code/resource';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import { CustomClientImpl } from '../../client/customClientImpl.js';
import {
  createCustomModelProviders,
  createCustomModelProvidersFromSettingsTexts,
  loadProjectCustomProviderConfigs,
} from './customModelProviderFactory.js';

vi.mock('../../client/customClientImpl.js', () => ({
  CustomClientImpl: vi.fn(),
}));

const transportManager = {
  resolve: () => ({}),
} as unknown as ModelTransportManager;
const settingsService = {} as SettingsService;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function settingsText(
  apiKey: string,
  baseUrl = 'https://gateway.example/v1',
  model = 'model-1',
): string {
  return JSON.stringify({
    providers: {
      local: {
        baseUrl,
        apiKey,
        model,
      },
    },
  });
}

describe('createCustomModelProviders', () => {
  it('ignores account-owned ids and keeps generic providers', () => {
    const providers = createCustomModelProviders(
      {
        'qwen-subscription': {
          baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
          apiKey: 'placeholder',
          models: [{ model: 'qwen3.8-max' }],
        },
        normal: {
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'secret',
          model: 'model-1',
        },
      },
      transportManager,
      settingsService,
      'user',
    );

    expect(providers.map((provider) => provider.providerId)).toEqual([
      'normal',
    ]);
  });

  it('returns nothing when only account-owned ids are configured', () => {
    const providers = createCustomModelProviders(
      { 'qwen-subscription': { anything: true } },
      transportManager,
      settingsService,
      'user',
    );

    expect(providers).toEqual([]);
  });
});

describe('createCustomModelProvidersFromSettingsTexts', () => {
  it.each(['$QWEN_TEST_API_KEY', '${QWEN_TEST_API_KEY}'])(
    'resolves %s before constructing the provider client',
    (reference) => {
      vi.stubEnv('QWEN_TEST_API_KEY', 'resolved-key');

      const providers = createCustomModelProvidersFromSettingsTexts(
        [settingsText(reference)],
        transportManager,
        settingsService,
        'user',
      );

      expect(providers.map((provider) => provider.providerId)).toEqual([
        'local',
      ]);
      expect(CustomClientImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          customProviderConfig: expect.objectContaining({
            apiKey: 'resolved-key',
          }),
        }),
      );
    },
  );

  it('resolves environment references across the provider block', () => {
    vi.stubEnv('QWEN_TEST_API_KEY', 'resolved-key');
    vi.stubEnv('QWEN_TEST_GATEWAY_URL', 'https://resolved.example/v1');
    vi.stubEnv('QWEN_TEST_MODEL', 'resolved-model');

    const providers = createCustomModelProvidersFromSettingsTexts(
      [
        settingsText(
          '$QWEN_TEST_API_KEY',
          '${QWEN_TEST_GATEWAY_URL}',
          '${QWEN_TEST_MODEL}',
        ),
      ],
      transportManager,
      settingsService,
      'user',
    );

    expect(providers.map((provider) => provider.providerId)).toEqual([
      'local',
    ]);
    expect(CustomClientImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        customProviderConfig: expect.objectContaining({
          apiKey: 'resolved-key',
          baseUrl: 'https://resolved.example/v1',
          models: expect.arrayContaining([
            expect.objectContaining({ key: 'local/resolved-model' }),
          ]),
        }),
      }),
    );
  });

  it('keeps rejecting an unresolved braced environment reference', () => {
    vi.stubEnv('QWEN_TEST_API_KEY', undefined);

    const providers = createCustomModelProvidersFromSettingsTexts(
      [settingsText('${QWEN_TEST_API_KEY}')],
      transportManager,
      settingsService,
      'user',
    );

    expect(providers).toEqual([]);
    expect(CustomClientImpl).not.toHaveBeenCalled();
  });
});

describe('loadProjectCustomProviderConfigs', () => {
  it('resolves environment references after applying local precedence', () => {
    vi.stubEnv('QWEN_PROJECT_API_KEY', 'project-key');
    vi.stubEnv('QWEN_LOCAL_API_KEY', 'local-key');
    const service = {
      getProjectSettingsSources: () => ({
        project: { read: () => settingsText('$QWEN_PROJECT_API_KEY') },
        local: { read: () => settingsText('${QWEN_LOCAL_API_KEY}') },
      }),
    } as unknown as SettingsService;

    const configs = loadProjectCustomProviderConfigs(
      service,
      '/tmp/qwen-project',
      true,
    );

    expect(configs).toHaveLength(1);
    expect(configs[0].apiKey).toBe('local-key');
  });

  it('does not resolve environment references for an untrusted project', () => {
    vi.stubEnv('QWEN_PROJECT_API_KEY', 'project-secret');
    const getProjectSettingsSources = vi.fn(() => ({
      project: { read: () => settingsText('${QWEN_PROJECT_API_KEY}') },
      local: { read: () => undefined },
    }));
    const service = {
      getProjectSettingsSources,
    } as unknown as SettingsService;

    const configs = loadProjectCustomProviderConfigs(
      service,
      '/tmp/qwen-project',
      false,
    );

    expect(configs).toEqual([]);
    expect(getProjectSettingsSources).not.toHaveBeenCalled();
  });
});
