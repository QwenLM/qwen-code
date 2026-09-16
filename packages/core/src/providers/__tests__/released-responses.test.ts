/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '../../core/contentGenerator.js';
import { ModelRegistry } from '../../models/modelRegistry.js';
import type {
  ModelProvidersConfig,
  ProviderProtocolConfig,
} from '../../models/types.js';
import { applyProviderInstallPlan } from '../install.js';
import {
  buildInstallPlan,
  findExistingProviderModels,
  getModelsForProviderProtocol,
} from '../provider-config.js';
import { customProvider } from '../presets/custom-provider.js';
import type { ProviderSettingsAdapter } from '../types.js';

const baseUrl = 'https://gateway.example/v1';
const inputs = {
  protocol: AuthType.USE_OPENAI,
  wireApi: 'responses' as const,
  baseUrl,
  modelIds: ['same'],
  apiKey: 'test-only-new',
};

function adapterFor(
  initial: ModelProvidersConfig,
  mapping?: ProviderProtocolConfig,
) {
  let own = initial;
  let snapshot = initial;
  const writes = vi.fn((key: string, value: unknown) => {
    if (key.startsWith('modelProviders.')) {
      own = {
        ...own,
        [key.slice('modelProviders.'.length)]:
          value as ModelProvidersConfig[string],
      };
    }
  });
  const adapter: ProviderSettingsAdapter = {
    getValue: (key) => (key === 'providerProtocol' ? mapping : undefined),
    getModelProviders: () => own,
    getModelProvidersForWrite: () => ({
      modelProviders: own,
      providerProtocol: mapping,
      shadowedProviders: [],
    }),
    setValue: writes,
    persist: vi.fn(),
    backup: () => {
      snapshot = own;
    },
    restore: () => {
      own = snapshot;
    },
  };
  return { adapter, writes };
}

afterEach(() => vi.unstubAllEnvs());

describe('released Responses configuration', () => {
  it.each(['openai-responses', 'gateway', 'openai'])(
    'reconfigures only the selected %s route and preserves references and siblings',
    async (providerId) => {
      vi.stubEnv('RELEASED_KEY', 'test-only-old');
      const mapping = { [providerId]: 'openai-responses' };
      const selected = {
        id: 'same',
        baseUrl,
        envKey: 'RELEASED_KEY',
        name: 'My model',
        generationConfig: { customHeaders: { 'X-Route': '${ROUTE_HEADER}' } },
      };
      const siblings = [
        { id: 'same', baseUrl: `${baseUrl}/`, envKey: 'SLASH_KEY' },
        {
          id: 'same',
          baseUrl,
          wireApi: 'chat-completions' as const,
          envKey: 'CHAT_KEY',
        },
        { id: 'image', baseUrl, imageOnly: true, envKey: 'IMAGE_KEY' },
      ];
      const initial = { [providerId]: [selected, ...siblings] };
      const before = structuredClone(initial);
      const { adapter } = adapterFor(initial, mapping);
      const existing = getModelsForProviderProtocol(
        initial,
        AuthType.USE_OPENAI,
        mapping,
      );
      const plan = buildInstallPlan(customProvider, inputs, existing);
      expect(plan.env).toEqual({ RELEASED_KEY: inputs.apiKey });
      expect(plan.modelProviders?.[0]?.authType).toBe(AuthType.USE_OPENAI);
      expect(plan.modelProviders?.[0]?.models).toEqual([
        {
          ...selected,
          wireApi: 'responses',
          generationConfig: selected.generationConfig,
        },
      ]);
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
      const result = adapter.getModelProviders();
      if (providerId !== 'openai') expect(result[providerId]).toEqual(siblings);
      const registry = new ModelRegistry(result, mapping);
      expect(
        registry.getModel(AuthType.USE_OPENAI_RESPONSES, 'same', baseUrl)
          ?.envKey,
      ).toBe('RELEASED_KEY');
      expect(
        registry.getModel(AuthType.USE_OPENAI_RESPONSES, 'same', `${baseUrl}/`)
          ?.envKey,
      ).toBe('SLASH_KEY');
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'same', baseUrl)?.envKey,
      ).toBe('CHAT_KEY');
      expect(
        registry.getModel(AuthType.USE_OPENAI_RESPONSES, 'image', baseUrl)
          ?.imageOnly,
      ).toBe(true);
      expect(initial).toEqual(before);
      expect(mapping).toEqual({ [providerId]: 'openai-responses' });
    },
  );

  it.each([true, false])(
    'removes the stale legacy winner (legacy first=%s)',
    async (legacyFirst) => {
      vi.stubEnv('RELEASED_KEY', 'test-only-old');
      const old = { id: 'same', baseUrl, envKey: 'RELEASED_KEY' };
      const canonical = { ...old, wireApi: 'responses' as const };
      const initial = legacyFirst
        ? { 'openai-responses': [old], openai: [canonical] }
        : { openai: [canonical], 'openai-responses': [old] };
      const { adapter } = adapterFor(initial);
      const plan = buildInstallPlan(
        customProvider,
        inputs,
        getModelsForProviderProtocol(initial, AuthType.USE_OPENAI),
      );
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        doRefreshAuth: false,
      });
      expect(adapter.getModelProviders()['openai-responses']).toEqual([]);
      expect(
        new ModelRegistry(adapter.getModelProviders()).getModelsForAuthType(
          AuthType.USE_OPENAI_RESPONSES,
        ),
      ).toHaveLength(1);
    },
  );

  it('keeps the released explicit mapping priority when reconfiguring an old named bucket', async () => {
    vi.stubEnv('RELEASED_KEY', 'test-only-old');
    const initial = {
      'openai-responses': [{ id: 'same', baseUrl, envKey: 'RELEASED_KEY' }],
    };
    const mapping = { 'openai-responses': 'openai' };
    const { adapter } = adapterFor(initial, mapping);
    const plan = buildInstallPlan(
      customProvider,
      { ...inputs, wireApi: 'chat-completions' },
      getModelsForProviderProtocol(initial, AuthType.USE_OPENAI, mapping),
    );
    await applyProviderInstallPlan(plan, {
      settings: adapter,
      doRefreshAuth: false,
    });
    expect(adapter.getModelProviders()['openai-responses']).toEqual([]);
    expect(
      new ModelRegistry(adapter.getModelProviders(), mapping).getModel(
        AuthType.USE_OPENAI,
        'same',
        baseUrl,
      )?.envKey,
    ).toBe('RELEASED_KEY');
  });

  it('rolls back when a legacy route in another scope still wins, without writing that bucket', async () => {
    const higher = {
      'openai-responses': [{ id: 'same', baseUrl, envKey: 'HIGHER_KEY' }],
    };
    const { adapter, writes } = adapterFor({});
    const own = adapter.getModelProviders;
    adapter.getModelProviders = () => ({ ...higher, ...own() });
    const plan = buildInstallPlan(customProvider, inputs);
    const envKey = Object.keys(plan.env!)[0]!;
    vi.stubEnv(envKey, 'test-only-old');
    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toMatchObject({ step: 'modelProviders' });
    expect(writes).not.toHaveBeenCalledWith(
      'modelProviders.openai-responses',
      expect.anything(),
    );
    expect(adapter.getModelProvidersForWrite?.().modelProviders).toEqual({});
    expect(adapter.getModelProviders()).toEqual(higher);
    expect(process.env[envKey]).toBe('test-only-old');
  });

  it('keeps a selected canonical Chat route when a retained legacy Responses sibling appears first', () => {
    const config = {
      ...customProvider,
      envKey: 'RELEASED_KEY',
      modelNamePrefix: '',
      ownsModel: undefined,
    };
    const model = { id: 'same', baseUrl, envKey: 'RELEASED_KEY' };
    const source = { 'openai-responses': [model], openai: [model] };
    expect(
      findExistingProviderModels(config, source, undefined, {
        authType: AuthType.USE_OPENAI,
        id: 'same',
        baseUrl,
      })?.protocol,
    ).toBe(AuthType.USE_OPENAI);
    expect(
      findExistingProviderModels(config, source, undefined, {
        authType: AuthType.USE_OPENAI_RESPONSES,
        id: 'same',
        baseUrl,
      })?.protocol,
    ).toBe(AuthType.USE_OPENAI_RESPONSES);
  });

  it('finds a preset through a released custom mapping without modifying defaults', () => {
    const config = {
      ...customProvider,
      envKey: 'RELEASED_KEY',
      modelNamePrefix: '',
      ownsModel: undefined,
    };
    const model = { id: 'saved', baseUrl, envKey: 'RELEASED_KEY' };
    const source = { gateway: [model] };
    expect(
      findExistingProviderModels(config, source, {
        gateway: 'openai-responses',
      }),
    ).toEqual({
      protocol: AuthType.USE_OPENAI_RESPONSES,
      models: [{ ...model, wireApi: 'responses' }],
    });
    expect(source).toEqual({ gateway: [model] });
    expect(model).not.toHaveProperty('wireApi');
  });
});
