/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SettingsService } from '@qwen-code/resource';
import { homedir, tmpdir } from '../../utils/paths.js';
import type { ModelTransportManager } from '../transport/modelTransportManager.js';
import {
  createCustomModelProviders,
  createCustomModelProvidersFromSettingsTexts,
  loadProjectCustomProviderConfigs,
} from './customModelProviderFactory.js';

const transportManager = {
  resolve: () => ({}),
} as unknown as ModelTransportManager;
const settingsService = {} as SettingsService;

function providerApiKey(provider: unknown): string | undefined {
  return (provider as { config?: { apiKey?: string } }).config?.apiKey;
}

function providerSettingsText(apiKey: string): string {
  return JSON.stringify({
    providers: {
      gw: {
        baseUrl: 'https://gw.example/v1',
        apiKey,
        model: 'm1',
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['braced', '${QWEN_FACTORY_TEST_KEY}', 'set-key', 'set-key'],
    ['bare', '$QWEN_FACTORY_TEST_KEY', 'set-key', 'set-key'],
    [
      'default when unset',
      '${QWEN_FACTORY_TEST_KEY:-fallback-key}',
      undefined,
      'fallback-key',
    ],
    [
      'set value over default',
      '${QWEN_FACTORY_TEST_KEY:-fallback-key}',
      'set-key',
      'set-key',
    ],
    [
      'empty value over default',
      '${QWEN_FACTORY_TEST_KEY:-fallback-key}',
      '',
      '',
    ],
    [
      'unresolved bare reference',
      '$QWEN_FACTORY_TEST_KEY',
      undefined,
      '$QWEN_FACTORY_TEST_KEY',
    ],
    ['literal', 'literal-key', 'set-key', 'literal-key'],
  ])(
    'preserves resolver behavior for %s keys',
    (_name, apiKey, env, expected) => {
      vi.stubEnv('QWEN_FACTORY_TEST_KEY', env);
      const providers = createCustomModelProvidersFromSettingsTexts(
        [providerSettingsText(apiKey)],
        transportManager,
        settingsService,
        'user',
      );

      expect(providers.map((provider) => provider.providerId)).toEqual(['gw']);
      expect(providerApiKey(providers[0])).toBe(expected);
    },
  );

  it('resolves JSONC with a BOM without reparsing the resolved value', () => {
    const key = 'test"key\\with//slashes';
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', key);
    const providers = createCustomModelProvidersFromSettingsTexts(
      [`\uFEFF// Comment\n${providerSettingsText('${QWEN_FACTORY_TEST_KEY}')}`],
      transportManager,
      settingsService,
      'user',
    );

    expect(providers.map(({ providerId }) => providerId)).toEqual(['gw']);
    expect(providerApiKey(providers[0])).toBe(key);
  });

  it('still drops a provider whose braced reference cannot resolve', () => {
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', undefined);
    const providers = createCustomModelProvidersFromSettingsTexts(
      [providerSettingsText('${QWEN_FACTORY_TEST_KEY}')],
      transportManager,
      settingsService,
      'user',
    );

    expect(providers).toEqual([]);
  });

  it('skips missing and non-object provider blocks but still throws for malformed JSON', () => {
    const fromTexts = (texts: ReadonlyArray<string | null | undefined>) =>
      createCustomModelProvidersFromSettingsTexts(
        texts,
        transportManager,
        settingsService,
        'user',
      );

    expect(
      fromTexts([undefined, null, 'null', '[]', '{}', '{"providers":[]}']),
    ).toEqual([]);
    expect(() => fromTexts(['{'])).toThrow(SyntaxError);
  });
});

describe('rejected environment keys during settings-text expansion', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function providerSettingsWithBaseUrl(baseUrl: string) {
    return JSON.stringify({
      providers: {
        gw: {
          baseUrl,
          apiKey: 'literal-key',
          model: 'm1',
        },
      },
    });
  }

  function providerBaseUrl(provider: unknown): string | undefined {
    return (provider as { config?: { baseUrl?: string } }).config?.baseUrl;
  }

  it('hides a rejected key so its reference resolves the default, then restores the value', () => {
    vi.stubEnv('QWEN_FACTORY_REJECTED_KEY', 'https://rejected.example/v1');
    const providers = createCustomModelProvidersFromSettingsTexts(
      [
        providerSettingsWithBaseUrl(
          '${QWEN_FACTORY_REJECTED_KEY:-https://default.example/v1}',
        ),
      ],
      transportManager,
      settingsService,
      'user',
      undefined,
      new Set(['QWEN_FACTORY_REJECTED_KEY']),
    );

    expect(providers.map((provider) => provider.providerId)).toEqual(['gw']);
    expect(providerBaseUrl(providers[0])).toBe('https://default.example/v1');
    expect(process.env['QWEN_FACTORY_REJECTED_KEY']).toBe(
      'https://rejected.example/v1',
    );
  });

  it('drops a provider whose rejected braced reference cannot resolve', () => {
    vi.stubEnv('QWEN_FACTORY_REJECTED_KEY', 'https://rejected.example/v1');
    const providers = createCustomModelProvidersFromSettingsTexts(
      [providerSettingsWithBaseUrl('${QWEN_FACTORY_REJECTED_KEY}')],
      transportManager,
      settingsService,
      'user',
      undefined,
      new Set(['QWEN_FACTORY_REJECTED_KEY']),
    );

    expect(providers).toEqual([]);
    expect(process.env['QWEN_FACTORY_REJECTED_KEY']).toBe(
      'https://rejected.example/v1',
    );
  });

  it('resolves keys normally when the rejection set omits them', () => {
    vi.stubEnv('QWEN_FACTORY_REJECTED_KEY', 'https://kept.example/v1');
    const providers = createCustomModelProvidersFromSettingsTexts(
      [providerSettingsWithBaseUrl('${QWEN_FACTORY_REJECTED_KEY}')],
      transportManager,
      settingsService,
      'user',
      undefined,
      new Set(['SOME_UNRELATED_KEY']),
    );

    expect(providers.map((provider) => provider.providerId)).toEqual(['gw']);
    expect(providerBaseUrl(providers[0])).toBe('https://kept.example/v1');
  });
});

describe('loadProjectCustomProviderConfigs', () => {
  const cwd = join(tmpdir(), 'qwen-project-providers-test');

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function projectSettings(projectText: string, localText?: string) {
    return {
      getProjectSettingsSources: vi.fn(() => ({
        project: { read: () => projectText },
        local: { read: () => localText },
      })),
    };
  }

  it('resolves project settings when there is no local override', () => {
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', 'project-key');
    const settings = projectSettings(
      providerSettingsText('${QWEN_FACTORY_TEST_KEY}'),
    );
    const configs = loadProjectCustomProviderConfigs(
      settings as unknown as SettingsService,
      cwd,
    );

    expect(configs.map((config) => config.providerId)).toEqual(['gw']);
    expect(configs[0]?.apiKey).toBe('project-key');
  });

  it('resolves the winning local definition, including nested model values', () => {
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', 'local-key');
    vi.stubEnv('QWEN_FACTORY_TEST_URL', 'https://local.example/v1');
    vi.stubEnv('QWEN_FACTORY_TEST_MODEL', 'local-model');
    const settings = projectSettings(
      providerSettingsText('project-key'),
      JSON.stringify({
        providers: {
          gw: {
            baseUrl: '${QWEN_FACTORY_TEST_URL}',
            apiKey: '$QWEN_FACTORY_TEST_KEY',
            models: [{ model: '${QWEN_FACTORY_TEST_MODEL}' }],
          },
        },
      }),
    );
    const configs = loadProjectCustomProviderConfigs(
      settings as unknown as SettingsService,
      cwd,
    );

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      providerId: 'gw',
      apiKey: 'local-key',
      baseUrl: 'https://local.example/v1',
    });
    expect(configs[0]?.models.map(({ key }) => key)).toEqual([
      'gw/local-model',
    ]);
  });

  it('does not fall back to the project definition when the local key cannot resolve', () => {
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', undefined);
    const settings = projectSettings(
      providerSettingsText('project-key'),
      providerSettingsText('${QWEN_FACTORY_TEST_KEY}'),
    );

    expect(
      loadProjectCustomProviderConfigs(
        settings as unknown as SettingsService,
        cwd,
      ),
    ).toEqual([]);
  });

  it('does not read project settings when the workspace is the home directory', () => {
    const settings = projectSettings(providerSettingsText('project-key'));

    expect(
      loadProjectCustomProviderConfigs(
        settings as unknown as SettingsService,
        homedir(),
      ),
    ).toEqual([]);
    expect(settings.getProjectSettingsSources).not.toHaveBeenCalled();
  });

  function spiedProjectSettings(projectText: string, localText: string) {
    const projectRead = vi.fn(() => projectText);
    const localRead = vi.fn(() => localText);
    const settings = {
      getProjectSettingsSources: vi.fn(() => ({
        project: { read: projectRead },
        local: { read: localRead },
      })),
    };
    return { settings, projectRead, localRead };
  }

  it('reads both layers when no source selection is provided', () => {
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', 'project-key');
    const { settings, projectRead, localRead } = spiedProjectSettings(
      providerSettingsText('${QWEN_FACTORY_TEST_KEY}'),
      providerSettingsText('local-key'),
    );

    const configs = loadProjectCustomProviderConfigs(
      settings as unknown as SettingsService,
      cwd,
    );

    expect(projectRead).toHaveBeenCalledTimes(1);
    expect(localRead).toHaveBeenCalledTimes(1);
    expect(configs.map((config) => config.providerId)).toEqual(['gw']);
  });

  it('reads only the project layer when the selection excludes local', () => {
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', 'project-key');
    const { settings, projectRead, localRead } = spiedProjectSettings(
      providerSettingsText('${QWEN_FACTORY_TEST_KEY}'),
      providerSettingsText('local-key'),
    );

    const configs = loadProjectCustomProviderConfigs(
      settings as unknown as SettingsService,
      cwd,
      ['project'],
    );

    expect(projectRead).toHaveBeenCalledTimes(1);
    expect(localRead).not.toHaveBeenCalled();
    expect(configs.map((config) => config.providerId)).toEqual(['gw']);
    expect(configs[0]?.apiKey).toBe('project-key');
  });

  it('reads only the local layer when the selection excludes project', () => {
    vi.stubEnv('QWEN_FACTORY_TEST_KEY', 'local-key');
    const { settings, projectRead, localRead } = spiedProjectSettings(
      providerSettingsText('project-key'),
      providerSettingsText('${QWEN_FACTORY_TEST_KEY}'),
    );

    const configs = loadProjectCustomProviderConfigs(
      settings as unknown as SettingsService,
      cwd,
      ['local'],
    );

    expect(projectRead).not.toHaveBeenCalled();
    expect(localRead).toHaveBeenCalledTimes(1);
    expect(configs.map((config) => config.providerId)).toEqual(['gw']);
    expect(configs[0]?.apiKey).toBe('local-key');
  });

  it('reads no layer for an empty source selection', () => {
    const { settings, projectRead, localRead } = spiedProjectSettings(
      providerSettingsText('project-key'),
      providerSettingsText('local-key'),
    );

    expect(
      loadProjectCustomProviderConfigs(
        settings as unknown as SettingsService,
        cwd,
        [],
      ),
    ).toEqual([]);
    expect(settings.getProjectSettingsSources).not.toHaveBeenCalled();
    expect(projectRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
  });

  it('reads no project layer when the selection only contains user', () => {
    const { settings, projectRead, localRead } = spiedProjectSettings(
      providerSettingsText('project-key'),
      providerSettingsText('local-key'),
    );

    expect(
      loadProjectCustomProviderConfigs(
        settings as unknown as SettingsService,
        cwd,
        ['user'],
      ),
    ).toEqual([]);
    expect(settings.getProjectSettingsSources).not.toHaveBeenCalled();
    expect(projectRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
  });
});
