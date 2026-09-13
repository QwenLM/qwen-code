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
} from './modelRegistry.js';
import { ModelsConfig } from './modelsConfig.js';
import type { ModelConfig, ModelProvidersConfig } from './types.js';

describe('model API selection', () => {
  afterEach(() => vi.unstubAllEnvs());
  const baseUrl = 'https://gateway.example/v1';
  const routes: ModelProvidersConfig = {
    openai: [
      { id: 'shared', api: 'responses', baseUrl, envKey: 'SHARED_KEY' },
      { id: 'shared', api: 'chat-completions', baseUrl, envKey: 'SHARED_KEY' },
    ],
  };

  it.each([
    [AuthType.USE_OPENAI, undefined, AuthType.USE_OPENAI],
    [AuthType.USE_OPENAI, 'chat-completions', AuthType.USE_OPENAI],
    [AuthType.USE_OPENAI, 'responses', AuthType.USE_OPENAI_RESPONSES],
    [AuthType.USE_OPENAI_RESPONSES, undefined, AuthType.USE_OPENAI_RESPONSES],
    [AuthType.USE_OPENAI_RESPONSES, 'responses', AuthType.USE_OPENAI_RESPONSES],
    [AuthType.USE_OPENAI_RESPONSES, 'chat-completions', AuthType.USE_OPENAI],
  ] as const)('resolves %s with api %s to %s', (protocol, api, expected) => {
    expect(resolveModelProtocol(protocol, { api })).toBe(expected);
    expect(
      resolveModelProtocol('gateway', { api }, { gateway: protocol }),
    ).toBe(expected);
  });

  it('does not let api validate an unknown provider', () => {
    expect(resolveModelProtocol('typo', { api: 'responses' })).toBeUndefined();
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
            [protocol]: [{ id: 'model', api: 'responses' }],
          }),
      ).toThrow('api is only supported for OpenAI-compatible models');
    },
  );

  it('rejects invalid API values and rolls back the whole registry reload', () => {
    const registry = new ModelRegistry(routes);
    expect(() =>
      registry.reloadModels({
        openai: [
          { id: 'new' },
          { id: 'broken', api: 'invalid' as ModelConfig['api'] },
        ],
      }),
    ).toThrow('Invalid api "invalid"');
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
      ...routes,
      'openai-responses': [{ id: 'shared', baseUrl, envKey: 'DUPLICATE_KEY' }],
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
        'openai-responses': [{ id: 'shared' }],
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

  it('can select an explicit Responses default when no model was requested', () => {
    expect(
      resolveModelSelectionAuthType(AuthType.USE_OPENAI, undefined, {
        openai: [{ id: 'shared', api: 'responses' }],
      }),
    ).toBe(AuthType.USE_OPENAI_RESPONSES);
  });

  it('resolves an explicitly requested image-only API so primary-model validation can reject it', () => {
    const providers: ModelProvidersConfig = {
      openai: [{ id: 'image', api: 'responses', imageOnly: true }],
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
              api: 'responses',
              baseUrl: 'https://other',
              envKey: 'SHARED_KEY',
            },
            { id: 'other-key', api: 'responses', baseUrl, envKey: 'OTHER_KEY' },
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
          { id: 'shared', api: 'responses', envKey: 'SHARED_KEY' },
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
      openai: [{ id: 'different', api: 'responses', envKey: 'OTHER_KEY' }],
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

  it('follows the selected model when a reload moves it to the sibling wire', () => {
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: { model: 'shared' },
      modelProvidersConfig: {
        openai: [{ id: 'shared', baseUrl, envKey: 'SHARED_KEY' }],
      },
    });
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
    // An install or settings edit that stamps `api` onto the same id+baseUrl
    // moves the model to the other wire; the sync must follow it rather than
    // throw "no longer configured" for a model that is still configured.
    config.reloadModelProvidersConfig({
      openai: [
        { id: 'shared', baseUrl, envKey: 'SHARED_KEY', api: 'responses' },
      ],
    });
    expect(() =>
      config.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'shared'),
    ).not.toThrow();
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(config.getGenerationConfig().model).toBe('shared');
  });

  it('adopts a same-endpoint sibling when the session has no registry baseUrl', () => {
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: { model: 'shared' },
      modelProvidersConfig: {
        openai: [{ id: 'shared', envKey: 'SHARED_KEY' }],
      },
    });
    expect(config.getCurrentRegistryBaseUrl()).toBeNull();
    // The model moved onto the sibling wire with an explicit default-equivalent
    // baseUrl; the session's own entry pinned no endpoint. The sibling lookup
    // must tolerate the representation difference, still gated on the same
    // dialed origin.
    config.reloadModelProvidersConfig({
      openai: [
        {
          id: 'shared',
          baseUrl: 'https://api.openai.com/v1',
          api: 'responses',
          envKey: 'SHARED_KEY',
        },
      ],
    });
    expect(() =>
      config.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'shared'),
    ).not.toThrow();
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(config.getGenerationConfig().model).toBe('shared');
  });

  it('does not adopt a sibling entry at a genuinely different origin', () => {
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: { model: 'shared' },
      modelProvidersConfig: {
        openai: [{ id: 'shared', envKey: 'SHARED_KEY' }],
      },
    });
    config.reloadModelProvidersConfig({
      openai: [
        {
          id: 'shared',
          baseUrl: 'https://other.example/v1',
          api: 'responses',
          envKey: 'SHARED_KEY',
        },
      ],
    });
    expect(() =>
      config.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'shared'),
    ).toThrow("Model 'shared' is no longer configured for authType 'openai'");
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
  });

  it('keeps a settings-sourced key when a reload adopts a baseUrl-less sibling entry', () => {
    vi.stubEnv('UNSET_KEY', undefined);
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'gpt-5',
        apiKey: 'settings-api-key',
        apiKeyEnvKey: 'UNSET_KEY',
        baseUrl: 'https://api.openai.com/v1',
      },
      generationConfigSources: {
        apiKey: { kind: 'settings' },
        baseUrl: { kind: 'modelProviders' },
      },
      modelProvidersConfig: {
        openai: [{ id: 'gpt-5', envKey: 'UNSET_KEY' }],
      },
    });
    // Stamping `api` onto the same baseUrl-less entry moves it onto the
    // sibling wire, whose resolved default baseUrl is '' — one endpoint, two
    // representations. The adoption must not read that as a provider change
    // and drop the session's key.
    config.reloadModelProvidersConfig({
      openai: [{ id: 'gpt-5', envKey: 'UNSET_KEY', api: 'responses' }],
    });
    config.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'gpt-5');
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(config.getGenerationConfig().apiKey).toBe('settings-api-key');
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
          { id: 'shared', api: 'responses', baseUrl, envKey: 'SHARED_KEY' },
        ],
      },
    });
    // The registry buckets `shared` under the Responses wire (its `api`), so
    // the setModel registry check against the session's current wire misses;
    // without the sibling probe the model id would be bound to the current
    // wire's credentials instead of its own entry.
    await config.setModel('shared');
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(config.getGenerationConfig().model).toBe('shared');
    expect(config.getGenerationConfig().baseUrl).toBe(baseUrl);
    expect(config.getGenerationConfig().apiKeyEnvKey).toBe('SHARED_KEY');
  });

  it('adopts a surviving same-endpoint sibling wire instead of failing closed', () => {
    const config = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI_RESPONSES,
      generationConfig: { model: 'shared', apiKey: 'old-key', baseUrl },
      modelProvidersConfig: routes,
    });
    config.syncAfterAuthRefresh(AuthType.USE_OPENAI_RESPONSES, 'shared');
    // The Responses route is removed but the same id+baseUrl survives on the
    // Chat wire: the selection is not dangling, so the sync adopts the sibling
    // wire (and keeps the session's key, same endpoint and envKey) instead of
    // throwing.
    config.reloadModelProvidersConfig({
      openai: [routes['openai'][1]],
    });
    config.syncAfterAuthRefresh(AuthType.USE_OPENAI_RESPONSES, 'shared');
    expect(config.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
    expect(config.getGenerationConfig().model).toBe('shared');
    expect(config.getGenerationConfig().apiKey).toBe('old-key');
  });
});
