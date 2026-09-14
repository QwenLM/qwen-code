/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import {
  ModelRegistry,
  resolveModelProtocol,
  resolveModelSelectionAuthType,
  tryResolveModelProtocol,
} from './modelRegistry.js';
import { ModelsConfig } from './modelsConfig.js';
import type {
  ModelConfig,
  ModelProvidersConfig,
  ProviderProtocolConfig,
} from './types.js';

describe('model API selection', () => {
  afterEach(() => vi.unstubAllEnvs());
  const baseUrl = 'https://gateway.example/v1';
  const routes: ModelProvidersConfig = {
    openai: [
      { id: 'shared', wireApi: 'responses', baseUrl, envKey: 'SHARED_KEY' },
      {
        id: 'shared',
        wireApi: 'chat-completions',
        baseUrl,
        envKey: 'SHARED_KEY',
      },
    ],
  };

  it.each([
    [AuthType.USE_OPENAI, undefined, AuthType.USE_OPENAI],
    [AuthType.USE_OPENAI, 'chat-completions', AuthType.USE_OPENAI],
    [AuthType.USE_OPENAI, 'responses', AuthType.USE_OPENAI_RESPONSES],
  ] as const)(
    'resolves %s with api %s to %s',
    (protocol, wireApi, expected) => {
      expect(resolveModelProtocol(protocol, { wireApi })).toBe(expected);
      expect(
        resolveModelProtocol('gateway', { wireApi }, { gateway: protocol }),
      ).toBe(expected);
    },
  );

  it.each<{
    models: ModelProvidersConfig | undefined;
    mapping?: ProviderProtocolConfig;
  }>([
    { models: { 'openai-responses': [{ id: 'old' }] } },
    { models: { 'openai-responses': [] } },
    {
      models: { gateway: [{ id: 'old' }] },
      mapping: { gateway: 'openai-responses' },
    },
    { models: undefined, mapping: { unused: 'openai-responses' } },
    {
      models: { 'openai-responses': [{ id: 'old' }] },
      mapping: { 'openai-responses': 'openai' },
    },
  ])(
    'reads released declarations without changing their source: %j',
    ({ models, mapping }) => {
      const before = JSON.stringify({ models, mapping });
      const registry = new ModelRegistry(models, mapping);
      const expected =
        mapping?.['openai-responses'] === 'openai'
          ? AuthType.USE_OPENAI
          : AuthType.USE_OPENAI_RESPONSES;
      if (Object.values(models ?? {}).some((entries) => entries.length)) {
        expect(registry.getModel(expected, 'old')).toBeDefined();
      }
      const reloaded = new ModelRegistry(routes);
      reloaded.reloadModels(models, mapping);
      expect(reloaded.getModelProvidersConfig()).toBe(models);
      expect(JSON.stringify({ models, mapping })).toBe(before);
    },
  );

  it('resolves released declarations in repair reads', () => {
    expect(tryResolveModelProtocol('openai-responses', {})).toBe(
      AuthType.USE_OPENAI_RESPONSES,
    );
    expect(
      tryResolveModelProtocol('gateway', {}, { gateway: 'openai-responses' }),
    ).toBe(AuthType.USE_OPENAI_RESPONSES);
  });

  it('resolves generic OpenAI startup against released Responses while keeping exact routes preferred', () => {
    const legacy = { 'openai-responses': [{ id: 'same', baseUrl }] };
    expect(
      resolveModelSelectionAuthType(
        AuthType.USE_OPENAI,
        'same',
        legacy,
        undefined,
        baseUrl,
      ),
    ).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(
      resolveModelSelectionAuthType(
        AuthType.USE_OPENAI,
        'same',
        {
          ...legacy,
          openai: [{ id: 'same', baseUrl }],
        },
        undefined,
        baseUrl,
      ),
    ).toBe(AuthType.USE_OPENAI);
  });

  it.each(['openai-responses', 'gateway'])(
    'allows explicit wire selection under the released %s protocol without accepting invalid values',
    (providerId) => {
      const mapping = { gateway: 'openai-responses' };
      expect(
        resolveModelProtocol(
          providerId,
          { wireApi: 'chat-completions' },
          mapping,
        ),
      ).toBe(AuthType.USE_OPENAI);
      expect(
        resolveModelProtocol(providerId, { wireApi: 'responses' }, mapping),
      ).toBe(AuthType.USE_OPENAI_RESPONSES);
      expect(() =>
        resolveModelProtocol(
          providerId,
          { wireApi: 'invalid' as ModelConfig['wireApi'] },
          mapping,
        ),
      ).toThrow('Invalid wireApi');
    },
  );

  it('does not let api validate an unknown provider', () => {
    expect(
      resolveModelProtocol('typo', { wireApi: 'responses' }),
    ).toBeUndefined();
    const registry = new ModelRegistry({ typo: routes['openai'] });
    expect(
      registry.getModelsForAuthType(AuthType.USE_OPENAI_RESPONSES),
    ).toEqual([]);
  });

  it.each([AuthType.USE_GEMINI, AuthType.USE_ANTHROPIC, AuthType.QWEN_OAUTH])(
    'rejects api under %s',
    (protocol) => {
      expect(
        () =>
          new ModelRegistry({
            [protocol]: [{ id: 'model', wireApi: 'responses' }],
          }),
      ).toThrow('wireApi is only supported for OpenAI-compatible models');
    },
  );

  it('rejects invalid API values and rolls back the whole registry reload', () => {
    const registry = new ModelRegistry(routes);
    expect(() =>
      registry.reloadModels({
        openai: [
          { id: 'new' },
          { id: 'broken', wireApi: 'invalid' as ModelConfig['wireApi'] },
        ],
      }),
    ).toThrow('Invalid wireApi "invalid"');
    expect(registry.getModelProvidersConfig()).toBe(routes);
    expect(registry.getModel(AuthType.USE_OPENAI, 'new')).toBeUndefined();
    expect(
      registry.getModel(AuthType.USE_OPENAI, 'shared', baseUrl),
    ).toBeDefined();
    expect(
      registry.getModel(AuthType.USE_OPENAI_RESPONSES, 'shared', baseUrl),
    ).toBeDefined();
  });

  it('keeps same model and URL routes separate, with first-wins duplicates', () => {
    const registry = new ModelRegistry({
      openai: [
        ...routes['openai'],
        {
          id: 'shared',
          baseUrl,
          wireApi: 'responses',
          envKey: 'DUPLICATE_KEY',
        },
      ],
    });
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toHaveLength(1);
    expect(
      registry.getModelsForAuthType(AuthType.USE_OPENAI_RESPONSES),
    ).toHaveLength(1);
    expect(
      registry.getModel(AuthType.USE_OPENAI_RESPONSES, 'shared', baseUrl)
        ?.envKey,
    ).toBe('SHARED_KEY');
    expect(
      registry.getModel(
        AuthType.USE_OPENAI_RESPONSES,
        'shared',
        'https://other',
      ),
    ).toBeUndefined();
  });

  it('prefers the current API when both APIs share the same model and URL', () => {
    for (const authType of [
      AuthType.USE_OPENAI,
      AuthType.USE_OPENAI_RESPONSES,
    ]) {
      expect(
        resolveModelSelectionAuthType(
          authType,
          'shared',
          routes,
          undefined,
          baseUrl,
        ),
      ).toBe(authType);
    }
  });

  it('prefers the requested endpoint before another endpoint using the current API', () => {
    const providers: ModelProvidersConfig = {
      openai: [
        { id: 'shared', baseUrl: 'https://other', envKey: 'OTHER_KEY' },
        routes['openai'][0],
      ],
    };
    expect(
      resolveModelSelectionAuthType(AuthType.USE_OPENAI, 'shared', providers),
    ).toBe(AuthType.USE_OPENAI);
    expect(
      resolveModelSelectionAuthType(
        AuthType.USE_OPENAI,
        'shared',
        providers,
        undefined,
        baseUrl,
      ),
    ).toBe(AuthType.USE_OPENAI_RESPONSES);
  });

  it('only falls back across APIs for an explicit api field', () => {
    expect(
      resolveModelSelectionAuthType(AuthType.USE_OPENAI, 'shared', {
        openai: [{ id: 'other', wireApi: 'responses' }],
      }),
    ).toBe(AuthType.USE_OPENAI);
    expect(
      resolveModelSelectionAuthType(
        AuthType.USE_OPENAI,
        'shared',
        { gateway: [routes['openai'][0]] },
        { gateway: 'openai' },
      ),
    ).toBe(AuthType.USE_OPENAI_RESPONSES);
  });

  it.each(['', null])(
    'treats %s as an explicitly selected route without a base URL',
    (selectedBaseUrl) => {
      expect(
        resolveModelSelectionAuthType(
          AuthType.USE_OPENAI,
          'shared',
          {
            openai: [
              { id: 'shared', baseUrl: 'https://proxy.example/v1' },
              { id: 'shared', wireApi: 'responses' },
            ],
          },
          undefined,
          selectedBaseUrl,
        ),
      ).toBe(AuthType.USE_OPENAI_RESPONSES);
    },
  );

  it('keeps the requested auth type when no model was selected', () => {
    expect(
      resolveModelSelectionAuthType(AuthType.USE_OPENAI, undefined, {
        openai: [{ id: 'shared', wireApi: 'responses' }],
      }),
    ).toBe(AuthType.USE_OPENAI);
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig: {
        openai: [{ id: 'shared', wireApi: 'responses' }],
      },
    });
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
  });

  it('resolves an explicitly requested image-only API so primary-model validation can reject it', () => {
    const providers: ModelProvidersConfig = {
      openai: [{ id: 'image', wireApi: 'responses', imageOnly: true }],
    };
    expect(
      resolveModelSelectionAuthType(AuthType.USE_OPENAI, undefined, providers),
    ).toBe(AuthType.USE_OPENAI);
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: { model: 'image' },
      modelProvidersConfig: providers,
    });
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(() =>
      config.syncAfterAuthRefresh(AuthType.USE_OPENAI_RESPONSES, 'image'),
    ).toThrow("Image-only model 'image' cannot be used as the primary model");
  });

  it('initializes core selection from the model api but keeps explicit switches exact', async () => {
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: { model: 'shared' },
      modelProvidersConfig: { openai: [routes['openai'][0]] },
    });
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    await expect(
      config.switchModel(AuthType.USE_OPENAI, 'shared'),
    ).rejects.toThrow("not found for authType 'openai'");
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
  });

  it.each(['other-endpoint', 'other-key'])(
    'reuses an injected key for sibling APIs but not %s',
    async (otherModel) => {
      vi.stubEnv('SHARED_KEY', undefined);
      vi.stubEnv('OTHER_KEY', undefined);
      const onModelChange = vi.fn();
      const config = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        generationConfig: {
          model: 'shared',
          baseUrl,
          apiKey: 'injected-key',
          apiKeyEnvKey: 'SHARED_KEY',
        },
        generationConfigSources: {
          apiKey: { kind: 'env', envKey: 'SHARED_KEY' },
        },
        modelProvidersConfig: {
          openai: [
            ...routes['openai'],
            {
              id: 'other-endpoint',
              wireApi: 'responses',
              baseUrl: 'https://other',
              envKey: 'SHARED_KEY',
            },
            {
              id: 'other-key',
              wireApi: 'responses',
              baseUrl,
              envKey: 'OTHER_KEY',
            },
          ],
        },
        onModelChange,
      });
      await config.switchModel(AuthType.USE_OPENAI_RESPONSES, 'shared', {
        baseUrl,
      });
      expect(config.getGenerationConfig().apiKey).toBe('injected-key');
      expect(onModelChange).toHaveBeenLastCalledWith(
        AuthType.USE_OPENAI_RESPONSES,
        true,
      );
      await config.switchModel(AuthType.USE_OPENAI, 'shared', { baseUrl });
      expect(config.getGenerationConfig().apiKey).toBe('injected-key');
      await config.switchModel(AuthType.USE_OPENAI_RESPONSES, otherModel);
      expect(config.getGenerationConfig().apiKey).toBeUndefined();
    },
  );

  it('reuses an injected key across sibling APIs when neither entry pins a baseUrl', async () => {
    vi.stubEnv('SHARED_KEY', undefined);
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'shared',
        apiKey: 'injected-key',
        apiKeyEnvKey: 'SHARED_KEY',
      },
      generationConfigSources: {
        apiKey: { kind: 'env', envKey: 'SHARED_KEY' },
      },
      modelProvidersConfig: {
        openai: [
          { id: 'shared', envKey: 'SHARED_KEY' },
          { id: 'shared', wireApi: 'responses', envKey: 'SHARED_KEY' },
        ],
      },
      onModelChange: vi.fn(),
    });
    // The two wires default differently for a baseUrl-less entry (Chat resolves
    // to DEFAULT_OPENAI_BASE_URL, Responses to ''), but both dial the same
    // origin — the switch must carry the key rather than dropping it.
    await config.switchModel(AuthType.USE_OPENAI_RESPONSES, 'shared');
    expect(config.getGenerationConfig().apiKey).toBe('injected-key');
    await config.switchModel(AuthType.USE_OPENAI, 'shared');
    expect(config.getGenerationConfig().apiKey).toBe('injected-key');
  });

  it('does not refresh a removed model into an unrelated default', async () => {
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI_RESPONSES,
      generationConfig: { model: 'shared', apiKey: 'old-key', baseUrl },
      modelProvidersConfig: routes,
    });
    config.syncAfterAuthRefresh(AuthType.USE_OPENAI_RESPONSES, 'shared');
    const before = structuredClone(config.getGenerationConfig());
    config.reloadModelProvidersConfig({
      openai: [{ id: 'different', wireApi: 'responses', envKey: 'OTHER_KEY' }],
    });
    expect(() =>
      config.syncAfterAuthRefresh(AuthType.USE_OPENAI_RESPONSES, 'shared'),
    ).toThrow('is no longer configured');
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(config.getGenerationConfig()).toEqual(before);
    await expect(
      config.switchModel(AuthType.USE_OPENAI_RESPONSES, 'shared', { baseUrl }),
    ).rejects.toThrow('not found');
    await config.switchModel(AuthType.USE_OPENAI_RESPONSES, 'different');
    expect(config.getGenerationConfig().model).toBe('different');
  });

  it.each([undefined, baseUrl])(
    'requires an explicit selection after an API edit at %s',
    async (entryBaseUrl) => {
      const config = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        generationConfig: { model: 'shared', apiKey: 'settings-key' },
        modelProvidersConfig: {
          openai: [{ id: 'shared', baseUrl: entryBaseUrl }],
        },
      });
      const before = structuredClone(config.getGenerationConfig());
      config.reloadModelProvidersConfig({
        openai: [{ id: 'shared', baseUrl: entryBaseUrl, wireApi: 'responses' }],
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() =>
          config.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'shared'),
        ).toThrow('is no longer configured');
        expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
        expect(config.getGenerationConfig()).toEqual(before);
      }
      await config.switchModel(AuthType.USE_OPENAI_RESPONSES, 'shared');
      expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    },
  );

  it('does not reuse an injected key between distinct Chat endpoints', async () => {
    vi.stubEnv('SHARED_KEY', undefined);
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: { model: 'a', apiKey: 'injected-key' },
      modelProvidersConfig: {
        openai: [
          {
            id: 'a',
            baseUrl: 'https://gateway.example/v1',
            envKey: 'SHARED_KEY',
          },
          { id: 'b', baseUrl: 'https://gateway.example', envKey: 'SHARED_KEY' },
        ],
      },
    });
    await config.switchModel(AuthType.USE_OPENAI, 'b');
    expect(config.getGenerationConfig().baseUrl).toBe(
      'https://gateway.example',
    );
    expect(config.getGenerationConfig().apiKey).toBeUndefined();
  });

  it('setModel follows a model registered on the sibling wire', async () => {
    vi.stubEnv('SHARED_KEY', undefined);
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'chat',
        apiKey: 'injected',
        apiKeyEnvKey: 'CHAT_KEY',
      },
      modelProvidersConfig: {
        openai: [
          { id: 'chat', envKey: 'CHAT_KEY' },
          { id: 'shared', wireApi: 'responses', baseUrl, envKey: 'SHARED_KEY' },
        ],
      },
    });
    // The registry buckets `shared` under the Responses wire (its `wireApi`), so
    // the setModel registry check against the session's current wire misses;
    // without the sibling probe the model id would be bound to the current
    // wire's credentials instead of its own entry.
    await config.setModel('shared');
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(config.getGenerationConfig().model).toBe('shared');
    expect(config.getGenerationConfig().baseUrl).toBe(baseUrl);
    expect(config.getGenerationConfig().apiKeyEnvKey).toBe('SHARED_KEY');
  });

  it('keeps a removed route selected until the user switches to its surviving sibling', async () => {
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI_RESPONSES,
      generationConfig: { model: 'shared', apiKey: 'old-key', baseUrl },
      modelProvidersConfig: routes,
    });
    config.syncAfterAuthRefresh(AuthType.USE_OPENAI_RESPONSES, 'shared');
    const before = structuredClone(config.getGenerationConfig());
    config.reloadModelProvidersConfig({ openai: [routes['openai'][1]] });
    expect(() =>
      config.syncAfterAuthRefresh(AuthType.USE_OPENAI_RESPONSES, 'shared'),
    ).toThrow('is no longer configured');
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(config.getGenerationConfig()).toEqual(before);
    await config.switchModel(AuthType.USE_OPENAI, 'shared', { baseUrl });
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
  });
});
