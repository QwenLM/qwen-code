/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCatalogModalities,
  loadModelMetadataCatalog,
  type ModelMetadataCatalog,
} from './model-metadata-catalog.js';

const catalog: ModelMetadataCatalog = {
  openrouter: {
    api: 'https://openrouter.ai/api/v1',
    env: ['OPENROUTER_API_KEY'],
    models: {
      'vendor/new-model': {
        id: 'vendor/new-model',
        modalities: {
          input: ['text', 'image', 'pdf', 'audio', 'video'],
        },
      },
      'vendor/text-model': {
        modalities: { input: ['text'] },
      },
    },
  },
};

const tempDirs: string[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })),
  );
});

describe('getCatalogModalities', () => {
  it('resolves all supported inputs through provider credentials', () => {
    expect(
      getCatalogModalities(catalog, {
        providerId: 'openai',
        modelId: 'VENDOR/NEW-MODEL',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      }),
    ).toEqual({ image: true, pdf: true, audio: true, video: true });
  });

  it('distinguishes catalog text-only metadata from missing metadata', () => {
    expect(
      getCatalogModalities(catalog, {
        providerId: 'openrouter',
        modelId: 'vendor/text-model',
      }),
    ).toEqual({});
    expect(
      getCatalogModalities(catalog, {
        providerId: 'openrouter',
        modelId: 'vendor/missing-model',
      }),
    ).toBeUndefined();
  });

  it('does not treat an unknown OpenAI-compatible endpoint as OpenAI', () => {
    expect(
      getCatalogModalities(
        {
          openai: {
            models: {
              'shared-model': {
                modalities: { input: ['text', 'image'] },
              },
            },
          },
        },
        {
          providerId: 'openai',
          authType: 'openai',
          modelId: 'shared-model',
          baseUrl: 'https://custom.example.com/v1',
          envKey: 'CUSTOM_API_KEY',
        },
      ),
    ).toBeUndefined();
  });

  it.each([
    ['https://coding.dashscope.aliyuncs.com/v1/', 'alibaba-coding-plan-cn'],
    ['https://coding-intl.dashscope.aliyuncs.com/v1', 'alibaba-coding-plan'],
    [
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      'alibaba-token-plan-cn',
    ],
    [
      'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      'alibaba-token-plan',
    ],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'alibaba-cn'],
    ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'alibaba'],
  ])('prefers the Alibaba endpoint catalog for %s', (baseUrl, expected) => {
    const endpoints = {
      alibaba: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      'alibaba-cn': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      'alibaba-coding-plan': 'https://coding-intl.dashscope.aliyuncs.com/v1',
      'alibaba-coding-plan-cn': 'https://coding.dashscope.aliyuncs.com/v1',
      'alibaba-token-plan':
        'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      'alibaba-token-plan-cn':
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    };
    const alibabaCatalog = Object.fromEntries(
      Object.entries(endpoints).map(([providerId, api]) => [
        providerId,
        {
          api,
          models: {
            'shared-model': {
              modalities: {
                input: providerId === expected ? ['text', 'image'] : ['text'],
              },
            },
          },
        },
      ]),
    );

    expect(
      getCatalogModalities(alibabaCatalog, {
        authType: 'openai',
        modelId: 'shared-model',
        baseUrl,
      }),
    ).toEqual({ image: true });
  });

  it('uses region-specific Alibaba defaults when no endpoint is configured', () => {
    expect(
      getCatalogModalities(
        {
          'alibaba-coding-plan-cn': {
            models: {
              'shared-model': { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        {
          providerId: 'coding-plan',
          modelId: 'shared-model',
        },
      ),
    ).toEqual({ image: true });
  });

  it('does not borrow Alibaba metadata for an unlisted regional endpoint', () => {
    expect(
      getCatalogModalities(
        {
          'alibaba-cn': {
            models: {
              'shared-model': { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        {
          providerId: 'alibabaStandard',
          modelId: 'shared-model',
          baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ),
    ).toBeUndefined();
  });

  it.each([
    'vendor/base-model:free',
    'vendor/base-model:extended',
    'vendor/base-model:thinking',
    'vendor/base-model:online',
    'vendor/base-model:nitro',
    'vendor/base-model:floor',
    'vendor/base-model:exacto',
  ])('falls back from OpenRouter variant %s to the base model', (modelId) => {
    expect(
      getCatalogModalities(
        {
          openrouter: {
            models: {
              'vendor/base-model': {
                modalities: { input: ['text', 'image'] },
              },
            },
          },
        },
        { providerId: 'openrouter', modelId },
      ),
    ).toEqual({ image: true });
  });

  it('prefers exact OpenRouter variant metadata and preserves unknown suffixes', () => {
    const variantCatalog: ModelMetadataCatalog = {
      openrouter: {
        models: {
          'vendor/base-model': {
            modalities: { input: ['text', 'image'] },
          },
          'vendor/base-model:free': { modalities: { input: ['text'] } },
        },
      },
    };

    expect(
      getCatalogModalities(variantCatalog, {
        providerId: 'openrouter',
        modelId: 'vendor/base-model:free',
      }),
    ).toEqual({});
    expect(
      getCatalogModalities(variantCatalog, {
        providerId: 'openrouter',
        modelId: 'vendor/base-model:unknown',
      }),
    ).toBeUndefined();
  });

  it.each([
    [
      'Qwen3.6-Plus-DogFooding',
      'alibaba-cn',
      'qwen3.6-plus',
      { image: true, video: true },
    ],
    ['bailian/deepseek-v4-pro', 'deepseek', 'deepseek-v4-pro', {}],
    ['bailian/deepseek-v4-flash', 'deepseek', 'deepseek-v4-flash', {}],
    [
      'bailian/kimi-k2.6',
      'moonshotai',
      'kimi-k2.6',
      { image: true, video: true },
    ],
  ])(
    'resolves the Idealab alias %s through %s model %s',
    (modelId, providerId, officialModelId, expected) => {
      expect(
        getCatalogModalities(
          {
            [providerId]: {
              models: {
                [officialModelId]: {
                  modalities: {
                    input:
                      Object.keys(expected).length > 0
                        ? ['text', 'image', 'video']
                        : ['text'],
                  },
                },
              },
            },
          },
          {
            providerId: 'idealab',
            modelId,
          },
        ),
      ).toEqual(expected);
    },
  );

  it('leaves an unknown Idealab alias to the local fallback', () => {
    expect(
      getCatalogModalities(
        {
          deepseek: {
            models: {
              'deepseek-unlisted': {
                modalities: { input: ['text', 'image'] },
              },
            },
          },
        },
        {
          providerId: 'idealab',
          modelId: 'bailian/deepseek-unlisted',
        },
      ),
    ).toBeUndefined();
  });
});

describe('loadModelMetadataCatalog', () => {
  it('uses a fresh disk cache without fetching', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    await fs.writeFile(cachePath, JSON.stringify(catalog));
    const fetchMock = vi.fn();

    await expect(
      loadModelMetadataCatalog({ cachePath, fetch: fetchMock }),
    ).resolves.toEqual(catalog);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the built-in snapshot without waiting for a cold-cache fetch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'nested', 'models-dev.json');
    const pendingResponse = deferred<Response>();
    const fetchMock = vi.fn(() => pendingResponse.promise);

    const loaded = await loadModelMetadataCatalog({
      cachePath,
      fetch: fetchMock,
    });

    expect(
      getCatalogModalities(loaded, {
        providerId: 'openai',
        modelId: 'gpt-4o',
      }),
    ).toEqual({ image: true, pdf: true });
    expect(
      getCatalogModalities(loaded, {
        providerId: 'coding-plan',
        modelId: 'glm-5',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      }),
    ).toEqual({});
    expect(
      getCatalogModalities(loaded, {
        providerId: 'openrouter',
        modelId: 'openai/gpt-oss-120b:free',
      }),
    ).toEqual({});
    expect(
      getCatalogModalities(loaded, {
        providerId: 'idealab',
        modelId: 'Qwen3.6-Plus-DogFooding',
      }),
    ).toEqual({ image: true, video: true });
    expect(
      getCatalogModalities(loaded, {
        providerId: 'idealab',
        modelId: 'bailian/deepseek-v4-pro',
      }),
    ).toEqual({});
    expect(
      getCatalogModalities(loaded, {
        providerId: 'idealab',
        modelId: 'bailian/kimi-k2.6',
      }),
    ).toEqual({ image: true, video: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('publishes a background refresh to later loads in the same process', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    const staleCatalog: ModelMetadataCatalog = {
      openrouter: {
        models: {
          'vendor/new-model': { modalities: { input: ['text', 'video'] } },
        },
      },
    };
    await fs.writeFile(cachePath, JSON.stringify(staleCatalog));
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(cachePath, staleTime, staleTime);
    const pendingResponse = deferred<Response>();
    const fetchMock = vi.fn(() => pendingResponse.promise);

    const first = await loadModelMetadataCatalog({
      cachePath,
      fetch: fetchMock,
    });
    expect(first).toEqual(staleCatalog);

    pendingResponse.resolve(new Response(JSON.stringify(catalog)));
    await vi.waitFor(async () => {
      await expect(
        loadModelMetadataCatalog({ cachePath, fetch: fetchMock }),
      ).resolves.toEqual(catalog);
    });

    expect(first).toEqual(staleCatalog);
    await expect(fs.readFile(cachePath, 'utf8')).resolves.toBe(
      JSON.stringify(catalog),
    );
  });

  it('keeps a stale cache when its background refresh fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    await fs.writeFile(cachePath, JSON.stringify(catalog));
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(cachePath, staleTime, staleTime);
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(
      loadModelMetadataCatalog({ cachePath, fetch: fetchMock }),
    ).resolves.toEqual(catalog);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    await expect(
      loadModelMetadataCatalog({ cachePath, fetch: fetchMock }),
    ).resolves.toEqual(catalog);
  });

  it('keeps the built-in snapshot when cache and network are unavailable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);

    const loaded = await loadModelMetadataCatalog({
      cachePath: path.join(dir, 'models-dev.json'),
      fetch: async () => {
        throw new Error('offline');
      },
    });

    expect(Object.keys(loaded).length).toBeGreaterThan(0);
    expect(
      getCatalogModalities(loaded, {
        providerId: 'openai',
        modelId: 'gpt-4o',
      }),
    ).toEqual({ image: true, pdf: true });
  });
});
