/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { QoderClient } from './client/qoderClient.js';
import type { QoderModelCatalogEntry } from './model-catalog.js';
import {
  createQoderModelResolver,
  toQoderModel,
} from './model-resolver.js';

function entry(
  overrides: Partial<QoderModelCatalogEntry> = {},
): QoderModelCatalogEntry {
  return {
    key: 'qwen-max',
    displayName: 'Qwen Max',
    enabled: true,
    isDefault: false,
    isVision: true,
    isReasoning: true,
    contextWindows: [200_000, 1_000_000],
    defaultContextWindow: 1_000_000,
    maxInputTokens: 180_000,
    maxOutputTokens: 32_000,
    reasoning: {
      efforts: ['low', 'high'],
      defaultEffort: 'low',
      canDisable: true,
    },
    ...overrides,
  };
}

function clientWithCatalog(
  list: () => Promise<QoderModelCatalogEntry[]>,
): QoderClient {
  return {
    api: {
      auth: {
        getStatus: async () => ({
          region: 'global',
          state: 'authenticated',
          canRefresh: true,
        }),
      },
      models: { list },
    },
  } as unknown as QoderClient;
}

describe('toQoderModel', () => {
  it('maps catalog capabilities, limits, and defaults', () => {
    const model = toQoderModel(entry());

    expect(model).toMatchObject({
      source: 'qoder',
      key: 'qwen-max',
      displayName: 'Qwen Max',
      enabled: true,
      capabilities: {
        tools: true,
        vision: true,
        reasoning: {
          supported: true,
          supportedEfforts: ['none', 'low', 'high'],
        },
        contextWindows: [{ tokens: 200_000 }, { tokens: 1_000_000 }],
      },
      limits: {
        maxContextTokens: 1_000_000,
        maxOutputTokens: 32_000,
      },
      defaultModelConfig: {
        reasoning: { effort: 'low' },
        context: { contextWindow: 1_000_000 },
      },
    });
  });

  it('uses the largest context tier as the limit and keeps the default', () => {
    const model = toQoderModel(
      entry({
        contextWindows: [200_000, 400_000, 1_000_000],
        defaultContextWindow: 200_000,
        maxInputTokens: 180_000,
      }),
    );

    expect(model.limits.maxContextTokens).toBe(1_000_000);
    expect(model.defaultModelConfig).toMatchObject({
      context: { contextWindow: 200_000 },
    });
    expect(model.capabilities.contextWindows.map(({ tokens }) => tokens)).toEqual(
      [200_000, 400_000, 1_000_000],
    );
  });

  it('falls back to standard efforts when the catalog omits them', () => {
    const model = toQoderModel(
      entry({ reasoning: { efforts: [], canDisable: false } }),
    );

    expect(model.capabilities.reasoning.supportedEfforts).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });
});

describe('createQoderModelResolver', () => {
  it('loads the catalog and writes it back for synchronous selectors', async () => {
    const models: Array<ReturnType<typeof toQoderModel>> = [];
    const list = vi.fn(async () => [entry()]);
    const resolver = createQoderModelResolver(clientWithCatalog(list), models);

    const listed = await resolver.listModels();

    expect(listed.map((model) => model.key)).toEqual(['qwen-max']);
    expect(models.map((model) => model.key)).toEqual(['qwen-max']);
    expect(
      await resolver.getModel('qwen-max'),
    ).toMatchObject({ displayName: 'Qwen Max' });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('caches until skipCache is requested', async () => {
    const models: Array<ReturnType<typeof toQoderModel>> = [];
    const list = vi.fn(async () => [entry()]);
    const resolver = createQoderModelResolver(clientWithCatalog(list), models);

    await resolver.listModels();
    await resolver.listModels();
    expect(list).toHaveBeenCalledTimes(1);

    await resolver.listModels({ skipCache: true });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('serves the stored catalog while refreshing it in the background', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const models: Array<ReturnType<typeof toQoderModel>> = [];
      const list = vi.fn(async () => [entry()]);
      const resolver = createQoderModelResolver(
        clientWithCatalog(list),
        models,
      );
      await resolver.listModels();
      expect(list).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_061_001);
      const cached = await resolver.listModels();
      expect(cached.map((model) => model.key)).toEqual(['qwen-max']);
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not synthesize auto from the catalog', async () => {
    const models: Array<ReturnType<typeof toQoderModel>> = [];
    const resolver = createQoderModelResolver(
      clientWithCatalog(async () => [
        entry(),
        entry({ key: 'qwen-default', displayName: 'Qwen Default', isDefault: true }),
      ]),
      models,
    );

    const listed = await resolver.listModels();
    expect(listed.map((model) => model.key)).toEqual([
      'qwen-max',
      'qwen-default',
    ]);
    await expect(resolver.getModel('auto')).resolves.toBeUndefined();
  });

  it('does not resolve auto when no account is connected', async () => {
    const models: Array<ReturnType<typeof toQoderModel>> = [];
    const list = vi.fn();
    const client = {
      api: {
        auth: {
          getStatus: async () => ({
            region: 'global',
            state: 'missing',
            canRefresh: false,
          }),
        },
        models: { list },
      },
    } as unknown as QoderClient;
    const resolver = createQoderModelResolver(client, models);

    await expect(resolver.listModels()).resolves.toEqual([]);
    await expect(resolver.getModel('auto')).resolves.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });

  it('stays empty when the catalog cannot be loaded', async () => {
    const models: Array<ReturnType<typeof toQoderModel>> = [];
    const resolver = createQoderModelResolver(
      clientWithCatalog(async () => {
        throw new Error('sign-in required');
      }),
      models,
    );

    await expect(resolver.listModels()).resolves.toEqual([]);
    expect(models).toEqual([]);
    await expect(resolver.getModel('auto')).resolves.toBeUndefined();
  });

  it('keeps the last good catalog when a later refresh fails', async () => {
    const models: Array<ReturnType<typeof toQoderModel>> = [];
    const list = vi
      .fn()
      .mockResolvedValueOnce([entry()])
      .mockRejectedValueOnce(new Error('network'));
    const resolver = createQoderModelResolver(clientWithCatalog(list), models);

    await resolver.listModels();
    const afterRefresh = await resolver.listModels({ skipCache: true });

    expect(afterRefresh.map((model) => model.key)).toEqual(['qwen-max']);
  });
});
