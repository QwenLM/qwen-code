/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  buildLiveSessionModelList,
  buildSessionModelList,
} from './buildSessionModelList.js';
import type { QoderListedModel } from '@qwen-code/core';
import { entryToListedModel } from '../../../core/src/test-utils/listed-model.js';
import type { ListedModelEntryFixture } from '../../../core/src/test-utils/listed-model-entry.js';

const mockGetAvailableModels = vi.fn();
const mockGetModelsForConfiguredScene = vi.fn();
const mockIsServiceAccountPrincipal = vi.fn(() => false);
const mockListModels = vi.fn();

vi.mock('@qwen-code/core', () => ({
  isServiceAccountPrincipal: () => mockIsServiceAccountPrincipal(),
  getSupportedContextWindows: () => [],
  isDirectConnectionModel: (model: { source: string; connection?: unknown }) =>
    model.source === 'qoder' && model.connection !== undefined,
}));

function directEntry(entry: {
  key: string;
  display_name: string;
  is_reasoning?: boolean;
  is_vl?: boolean;
}) {
  return {
    key: entry.key,
    display_name: entry.display_name,
    is_default: false,
    enable: true,
    is_reasoning: !!entry.is_reasoning,
    is_vl: !!entry.is_vl,
    is_new: false,
    max_input_tokens: 128_000,
    max_output_tokens: 8_192,
    source: 'user',
    format: 'openai',
    tags: [],
  };
}

/** 快照里的 provider 模型；服务端来源桶落在 catalogSource。 */
function snapshotModel(
  entry: { key: string },
  local: boolean,
): QoderListedModel {
  const raw = entry as ListedModelEntryFixture;
  const model = entryToListedModel({
    ...raw,
    source: local ? 'user' : 'system',
  });
  return local ? model : { ...model, catalogSource: raw.source ?? 'system' };
}

function makeConfig(direct: Array<Parameters<typeof directEntry>[0]> = []): {
  getModelProviderManager: () => {
    listModels: typeof mockListModels;
  };
} {
  const listedModels = () => [
    ...(
      (mockGetModelsForConfiguredScene() as
        | Array<{ key: string; source?: string }>
        | undefined) ?? []
    ).map((entry) => snapshotModel(entry, entry.source === 'user')),
    ...direct.map((entry) => snapshotModel(directEntry(entry), true)),
  ];
  mockListModels.mockImplementation(async () => listedModels());
  return {
    getModelProviderManager: () => ({ listModels: mockListModels }),
  };
}

describe('buildSessionModelList', () => {
  beforeEach(() => {
    mockGetAvailableModels.mockReset();
    mockGetModelsForConfiguredScene.mockReset();
    mockListModels.mockReset();
    mockIsServiceAccountPrincipal.mockReturnValue(false);
  });

  it('does not append direct-connection models to the SA catalog in cached or live SDK lists', async () => {
    mockIsServiceAccountPrincipal.mockReturnValue(true);
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'sa-model',
        display_name: 'SA Model',
        is_default: true,
        enable: true,
        is_reasoning: false,
        is_vl: false,
        is_new: false,
        source: 'system',
        format: 'openai',
        tags: [],
      },
    ]);
    const config = makeConfig([
      { key: 'local-direct', display_name: 'Local Direct' },
    ]) as unknown as Parameters<typeof buildSessionModelList>[0];

    expect(
      (await buildSessionModelList(config)).map((model) => model.modelId),
    ).toEqual(['sa-model']);
    expect(
      (await buildLiveSessionModelList(config)).map((model) => model.modelId),
    ).toEqual(['sa-model']);
  });

  it.each(['system', 'user', 'organization', 'custom'] as const)(
    'preserves source=%s without leaking secrets',
    async (source) => {
      mockGetModelsForConfiguredScene.mockReturnValue([
        {
          key: 'ultimate',
          display_name: 'Ultimate',
          is_default: true,
          enable: true,
          is_reasoning: true,
          is_vl: false,
          is_new: false,
          max_input_tokens: 200_000,
          max_output_tokens: 8192,
          price_factor: 1.6,
          original_price_factor: 1.6,
          source,
          format: 'openai',
          tags: [],
          is_free: true,
          // Unknown credential-bearing fields MUST never reach the DTO.
          connection_parameters: { api_key: 'sk-secret' },
        },
      ]);

      const list = await buildSessionModelList(
        makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
      );
      expect(list).toHaveLength(1);
      const entry = list[0];
      expect(entry.modelId).toBe('ultimate');
      expect(entry.source).toBe(source);
      expect(entry.isDefault).toBe(true);
      expect(entry.isEnabled).toBe(true);
      expect(entry.description).toBe('');
      expect(entry).not.toHaveProperty('priceFactor');
      expect(entry).not.toHaveProperty('isFree');
      // Structural guarantee — credentials never leak via the DTO.
      expect(JSON.stringify(entry)).not.toContain('sk-secret');
      expect(entry).not.toHaveProperty('connection_parameters');
      const liveList = await buildLiveSessionModelList(
        makeConfig() as unknown as Parameters<
          typeof buildLiveSessionModelList
        >[0],
      );
      expect(liveList).toEqual(list);
    },
  );

  it('does not add price fields when the source model omits them', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'unpriced',
        display_name: 'Unpriced',
        is_default: false,
        enable: true,
        is_reasoning: true,
        is_vl: false,
        is_new: false,
        max_input_tokens: 200_000,
        max_output_tokens: 8192,
        source: 'system',
        format: 'openai',
        tags: [],
      },
    ]);

    const [entry] = await buildSessionModelList(
      makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
    );

    expect(entry?.description).toBe('');
    expect(entry).not.toHaveProperty('priceFactor');
    expect(entry).not.toHaveProperty('originalPriceFactor');
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['non-string', { en: 'English description' }],
  ])(
    'returns an empty English description when description_en is %s',
    async (_case, descriptionEn) => {
      mockGetModelsForConfiguredScene.mockReturnValue([
        {
          key: 'description-en-fallback-model',
          display_name: 'Description EN Fallback Model',
          is_default: false,
          enable: true,
          is_reasoning: false,
          is_vl: false,
          is_new: false,
          source: 'system',
          format: 'openai',
          tags: [],
          server_model: {
            key: 'description-en-fallback-model',
            ...(descriptionEn !== undefined
              ? { description_en: descriptionEn }
              : {}),
          },
        },
      ]);

      const [entry] = await buildSessionModelList(
        makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
      );

      expect(entry).toMatchObject({ description: '', descriptionEn: '' });
    },
  );

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['non-string', { zh: '服务端描述' }],
  ])(
    'returns an empty description when the server description is %s',
    async (_case, description) => {
      mockGetModelsForConfiguredScene.mockReturnValue([
        {
          key: 'fallback-model',
          display_name: 'Fallback Model',
          is_default: false,
          enable: true,
          is_reasoning: true,
          is_vl: true,
          is_new: false,
          max_input_tokens: 200_000,
          max_output_tokens: 8192,
          source: 'system',
          format: 'openai',
          tags: [],
          server_model: {
            key: 'fallback-model',
            ...(description === undefined ? {} : { description }),
          },
        },
      ]);

      const [entry] = await buildSessionModelList(
        makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
      );

      expect(entry?.description).toBe('');
    },
  );

  it('returns only base models and the explicitly requested external providers', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'catalog-model',
        display_name: 'Example Model',
        source: 'system',
      },
      {
        key: 'cmcc/qwen3.5-plus',
        display_name: 'CMCC Qwen',
        source: 'system',
        outer_provider: 'cmcc',
      },
      {
        key: 'provider-b/qwen3.5-plus',
        display_name: 'Provider B Qwen',
        source: 'system',
        outer_provider: 'provider-b',
      },
    ]);

    const config = makeConfig() as unknown as Parameters<
      typeof buildSessionModelList
    >[0];
    const list = await buildSessionModelList(config, {
      outerProviders: ['provider-b'],
    });

    expect(list.map((entry) => entry.value)).toEqual([
      'catalog-model',
      'provider-b/qwen3.5-plus',
    ]);
    expect(
      (await buildSessionModelList(config)).map((entry) => entry.value),
    ).toEqual(['catalog-model', 'cmcc/qwen3.5-plus', 'provider-b/qwen3.5-plus']);
  });

  it('exposes rich catalog fields (reasoning/vl/tokens/strategies/direct url+model+provider)', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'direct-gpt5',
        display_name: 'GPT-5 (Direct)',
        is_default: false,
        enable: true,
        is_reasoning: true,
        is_vl: true,
        is_new: true,
        max_input_tokens: 250_000,
        max_output_tokens: 16_000,
        price_factor: 0.5,
        original_price_factor: 0.8,
        source: 'user',
        format: 'openai',
        scene: 'chat',
        icon: 'https://cdn.example.com/icons/gpt-5.svg',
        url: 'https://api.openai.com/v1',
        model: 'gpt-5',
        provider: 'openai',
        tags: ['DogFooding'],
        strategies: [
          { tag: 'C4', enabled: false, disabled_message_key: 'reason' },
        ],
        default_effort: 'high',
        function_switches: [
          {
            key: 'highspeed',
            type: 'bool',
            options: {
              false: { actions: [], is_default: true },
              true: {
                actions: [
                  {
                    type: 'replace_model_key',
                    parameters: { target: 'direct-gpt5-highspeed' },
                  },
                ],
              },
            },
          },
        ],
        connection_parameters: { api_key: 'sk-secret' },
      },
    ]);

    const list = await buildSessionModelList(
      makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
    );
    const entry = list[0];
    expect(entry.isReasoning).toBe(true);
    expect(entry.isVl).toBe(true);
    expect(entry.maxInputTokens).toBe(250_000);
    expect(entry.maxOutputTokens).toBe(16_000);
    expect(entry).not.toHaveProperty('originalPriceFactor');
    expect(entry.tags).toEqual(['DogFooding']);
    expect(entry.strategies).toEqual([
      { tag: 'C4', enabled: false, disabled_message_key: 'reason' },
    ]);
    expect(entry.format).toBe('openai');
    expect(entry.icon).toBe('https://cdn.example.com/icons/gpt-5.svg');
    expect(entry.url).toBe('https://api.openai.com/v1');
    expect(entry.model).toBe('gpt-5');
    expect(entry.provider).toBe('openai');
    expect(entry.defaultEffort).toBe('high');
    expect(entry).not.toHaveProperty('function_switches');
    // Credentials must still be stripped.
    expect(JSON.stringify(entry)).not.toContain('sk-secret');
    expect(entry).not.toHaveProperty('connection_parameters');
  });

  it('does not project commercial promotion data', async () => {
    const promotion = {
      active: true,
      rule_id: 'night_qmodel',
      discount_factor: 0.5,
      before_promotion_price_factor: 0.2,
      badge: { en: 'Off-Peak 50% off', zh: '错峰5折' },
      description: {
        en: 'Off-Peak 50% off (SGT 20:00-8:00)',
        zh: '错峰时段5折优惠（新加坡时间 20:00-8:00）',
      },
      window_start: '20:00',
      window_end: '08:00',
      timezone: 'Asia/Shanghai',
    };
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'qmodel',
        display_name: 'Qwen3.7-Max',
        is_default: false,
        enable: true,
        is_reasoning: false,
        is_vl: true,
        is_new: false,
        max_input_tokens: 200_000,
        max_output_tokens: 16_000,
        price_factor: 0.1,
        original_price_factor: 0.5,
        source: 'system',
        format: 'dashscope',
        promotion,
      },
    ]);

    const list = await buildSessionModelList(
      makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
    );

    expect(list[0]).not.toHaveProperty('promotion');
  });

  it('omits promotion when the catalog entry has none', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'qmodel',
        display_name: 'Qwen3.7-Max',
        is_default: false,
        enable: true,
        is_reasoning: false,
        is_vl: true,
        is_new: false,
        max_input_tokens: 200_000,
        max_output_tokens: 16_000,
        price_factor: 0.1,
        original_price_factor: 0.5,
        source: 'system',
        format: 'dashscope',
      },
    ]);

    const list = await buildSessionModelList(
      makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
    );

    expect(list[0]).not.toHaveProperty('promotion');
  });

  it('maps is_new → isNew for the New Models tab split', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'fresh',
        display_name: 'Fresh',
        is_default: false,
        enable: true,
        is_reasoning: false,
        is_vl: false,
        is_new: true,
        max_input_tokens: 128_000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'system',
        format: 'openai',
        tags: [],
      },
    ]);

    const list = await buildSessionModelList(
      makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
    );
    expect(list[0].isNew).toBe(true);
  });

  it('includes disabled catalog entries and preserves their enabled state', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'disabled-preview',
        display_name: 'Disabled Preview',
        is_default: false,
        enable: false,
        is_reasoning: false,
        is_vl: false,
        is_new: true,
        max_input_tokens: 128_000,
        max_output_tokens: 8192,
        price_factor: 0,
        original_price_factor: 0,
        source: 'system',
        format: 'openai',
        tags: ['DogFooding'],
      },
    ]);

    const list = await buildSessionModelList(
      makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(
      expect.objectContaining({
        modelId: 'disabled-preview',
        isEnabled: false,
        isNew: true,
      }),
    );
  });

  it('includes supported reasoning effort levels', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'reasoning',
        display_name: 'Reasoning',
        is_default: false,
        enable: true,
        is_reasoning: true,
        is_vl: false,
        is_new: false,
        efforts: ['low', 'high'],
        max_input_tokens: 128_000,
        max_output_tokens: 8192,
        price_factor: 1,
        original_price_factor: 1,
        source: 'system',
        format: 'openai',
        tags: [],
      },
    ]);

    const list = await buildSessionModelList(
      makeConfig() as unknown as Parameters<typeof buildSessionModelList>[0],
    );
    expect(list[0].efforts).toEqual(['low', 'high']);
  });

  it('includes direct-connection entries from config and labels them source="user"', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([]);
    const list = await buildSessionModelList(
      makeConfig([
        {
          key: 'direct-gpt4',
          display_name: 'GPT-4 (Direct)',
        },
      ]) as unknown as Parameters<typeof buildSessionModelList>[0],
    );
    expect(list).toEqual([
      expect.objectContaining({
        modelId: 'direct-gpt4',
        displayName: 'GPT-4 (Direct)',
        source: 'user',
      }),
    ]);
    expect(list[0]).not.toHaveProperty('priceFactor');
    expect(list[0]).not.toHaveProperty('originalPriceFactor');
    expect(list[0].description).toBe('');
  });

  it('de-dupes by modelId, catalog entry wins', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'shared',
        display_name: 'Shared (from catalog)',
        is_default: false,
        enable: true,
        is_reasoning: false,
        is_vl: false,
        is_new: false,
        max_input_tokens: 1,
        max_output_tokens: 1,
        price_factor: 1,
        original_price_factor: 1,
        source: 'user',
        format: 'openai',
        tags: [],
      },
    ]);
    const list = await buildSessionModelList(
      makeConfig([
        { key: 'shared', display_name: 'Shared (from direct config)' },
      ]) as unknown as Parameters<typeof buildSessionModelList>[0],
    );
    expect(list).toHaveLength(1);
    expect(list[0].displayName).toBe('Shared (from catalog)');
  });

  it('builds SDK on-demand model lists from a live manager refresh instead of the snapshot', async () => {
    mockGetModelsForConfiguredScene.mockReturnValue([
      {
        key: 'stale-catalog',
        display_name: 'Stale Catalog',
        is_default: false,
        enable: true,
        is_reasoning: false,
        is_vl: false,
        is_new: false,
        max_input_tokens: 1,
        max_output_tokens: 1,
        source: 'system',
        format: 'openai',
        tags: [],
      },
    ]);
    const config = makeConfig() as unknown as Parameters<
      typeof buildLiveSessionModelList
    >[0];
    mockListModels.mockResolvedValueOnce([
      snapshotModel(
        {
          key: 'live-server',
          display_name: 'Live Server',
          is_default: true,
          enable: true,
          is_reasoning: true,
          is_vl: false,
          is_new: false,
          max_input_tokens: 200_000,
          max_output_tokens: 8192,
          price_factor: 0.5,
          original_price_factor: 1,
          source: 'organization',
          format: 'openai',
          tags: ['limited_time_free'],
          server_scene: 'organization_models',
        } as ListedModelEntryFixture,
        false,
      ),
      snapshotModel(
        directEntry({ key: 'direct-live', display_name: 'Direct Live' }),
        true,
      ),
    ]);

    const list = await buildLiveSessionModelList(config);

    expect(mockListModels).toHaveBeenCalledExactlyOnceWith({ skipCache: true });
    expect(list.map((model) => model.modelId)).toEqual([
      'live-server',
      'direct-live',
    ]);
    expect(list[0]).toEqual(
      expect.objectContaining({
        displayName: 'Live Server',
        source: 'organization',
        isDefault: true,
        isReasoning: true,
        serverScene: 'organization_models',
      }),
    );
    expect(list[1]?.source).toBe('user');
  });

  it('keeps live SDK model price fields absent when the server omits them', async () => {
    const config = makeConfig() as unknown as Parameters<
      typeof buildLiveSessionModelList
    >[0];
    mockListModels.mockResolvedValueOnce([
      snapshotModel(
        {
          key: 'live-unpriced',
          display_name: 'Live Unpriced',
          is_default: false,
          enable: true,
          is_reasoning: true,
          is_vl: false,
          is_new: false,
          max_input_tokens: 200_000,
          max_output_tokens: 8192,
          source: 'system',
          format: 'openai',
          tags: [],
        } as ListedModelEntryFixture,
        false,
      ),
    ]);

    const [entry] = await buildLiveSessionModelList(config);

    expect(entry).toMatchObject({ description: '', descriptionEn: '' });
    expect(entry).not.toHaveProperty('priceFactor');
    expect(entry).not.toHaveProperty('originalPriceFactor');
  });

  it('forwards outerProviders and exposes the server unique key and provider', async () => {
    const config = makeConfig() as unknown as Parameters<
      typeof buildLiveSessionModelList
    >[0];
    mockListModels.mockResolvedValueOnce([
      snapshotModel(
        {
          key: 'cmcc/qwen3.5-plus',
          display_name: 'Qwen3.5 Plus',
          outer_provider: 'cmcc',
          is_default: false,
          enable: true,
          is_reasoning: true,
          is_vl: true,
          is_new: false,
          max_input_tokens: 1_024_000,
          max_output_tokens: 8192,
          source: 'system',
          format: 'openai',
          tags: [],
        } as ListedModelEntryFixture,
        false,
      ),
    ]);

    const [entry] = await buildLiveSessionModelList(config, {
      outerProviders: ['cmcc'],
    });

    expect(mockListModels).toHaveBeenCalledWith({
      skipCache: true,
      outerProviders: ['cmcc'],
    });
    expect(entry).toMatchObject({
      value: 'cmcc/qwen3.5-plus',
      modelId: 'cmcc/qwen3.5-plus',
      outerProvider: 'cmcc',
      isVl: true,
      maxInputTokens: 1_024_000,
    });
  });
});
