/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Storage } from '../config/storage.js';
import {
  getCatalogModalities,
  loadModelMetadataCatalog,
  type ModelMetadataCatalog,
} from './model-metadata-catalog.js';

const runtimeFetchMock = vi.hoisted(() => ({
  loadUndici: vi.fn(),
}));

vi.mock('../utils/runtimeFetchOptions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/runtimeFetchOptions.js')>();
  return { ...actual, loadUndici: runtimeFetchMock.loadUndici };
});

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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runtimeFetchMock.loadUndici.mockReset();
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

  it('uses attachment metadata when a catalog model omits input modalities', () => {
    expect(
      getCatalogModalities(
        {
          openai: {
            models: { 'attach-model': { attachment: true } },
          },
        },
        { providerId: 'openai', modelId: 'attach-model' },
      ),
    ).toEqual({ image: true });
  });

  it('resolves a unique credential environment key without endpoint evidence', () => {
    expect(
      getCatalogModalities(
        {
          vendor: {
            env: ['VENDOR_API_KEY'],
            models: {
              'vendor-model': { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        { modelId: 'vendor-model', envKey: 'VENDOR_API_KEY' },
      ),
    ).toEqual({ image: true });
  });

  it('does not resolve an ambiguous credential environment key', () => {
    expect(
      getCatalogModalities(
        {
          first: {
            env: ['SHARED_API_KEY'],
            models: {
              'shared-model': { modalities: { input: ['text', 'image'] } },
            },
          },
          second: {
            env: ['SHARED_API_KEY'],
            models: {
              'shared-model': { modalities: { input: ['text', 'video'] } },
            },
          },
        },
        { modelId: 'shared-model', envKey: 'SHARED_API_KEY' },
      ),
    ).toBeUndefined();
  });

  it.each([
    ['token-plan', 'alibaba-token-plan-cn'],
    ['alibabaStandard', 'alibaba-cn'],
    ['grok', 'xai'],
    ['gemini', 'google'],
    ['vertex-ai', 'google'],
  ])('maps provider id %s to %s', (providerId, catalogProviderId) => {
    expect(
      getCatalogModalities(
        {
          [catalogProviderId]: {
            models: {
              model: { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        { providerId, modelId: 'model' },
      ),
    ).toEqual({ image: true });
  });

  it('prefers providerId over authType when both match the catalog', () => {
    expect(
      getCatalogModalities(
        {
          minimax: {
            models: {
              model: { modalities: { input: ['text', 'image'] } },
            },
          },
          openai: {
            models: {
              model: { modalities: { input: ['text', 'video'] } },
            },
          },
        },
        { providerId: 'minimax', authType: 'openai', modelId: 'model' },
      ),
    ).toEqual({ image: true });
  });

  it('does not use authType when an unknown base URL is provider evidence', () => {
    expect(
      getCatalogModalities(
        {
          openai: {
            models: {
              model: { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        {
          authType: 'openai',
          modelId: 'model',
          baseUrl: 'https://unknown.example/v1',
        },
      ),
    ).toBeUndefined();
  });

  it('uses the protocol catalog for its canonical base URL', () => {
    expect(
      getCatalogModalities(
        {
          openai: {
            env: ['OPENAI_API_KEY'],
            models: {
              'gpt-4o': {
                modalities: { input: ['text', 'image', 'pdf'] },
              },
            },
          },
        },
        {
          providerId: 'openai',
          authType: 'openai',
          modelId: 'gpt-4o',
          baseUrl: 'https://api.openai.com/v1',
        },
      ),
    ).toEqual({ image: true, pdf: true });
  });

  it.each(['coding-plan', 'token-plan'])(
    'does not borrow the default %s catalog for an unknown endpoint',
    (providerId) => {
      expect(
        getCatalogModalities(
          {
            [`alibaba-${providerId}-cn`]: {
              models: {
                'qwen-vl-model': {
                  modalities: { input: ['text', 'image'] },
                },
              },
            },
          },
          {
            providerId,
            authType: 'openai',
            modelId: 'qwen-vl-model',
            baseUrl: 'https://unknown.example/v1',
          },
        ),
      ).toBeUndefined();
    },
  );

  it('resolves an auth-type-only lookup without provider evidence', () => {
    expect(
      getCatalogModalities(
        {
          alibaba: {
            models: {
              'qwen-vl-max': { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        { authType: 'qwen-oauth', modelId: 'qwen-vl-max' },
      ),
    ).toEqual({ image: true });
  });

  it('ignores the Qwen OAuth placeholder baseUrl replayed by the registry', () => {
    expect(
      getCatalogModalities(
        {
          alibaba: {
            models: {
              'qwen3-omni-flash': {
                modalities: { input: ['text', 'image', 'audio', 'video'] },
              },
            },
          },
        },
        {
          authType: 'qwen-oauth',
          modelId: 'qwen3-omni-flash',
          baseUrl: 'DYNAMIC_QWEN_OAUTH_BASE_URL',
        },
      ),
    ).toEqual({ image: true, audio: true, video: true });
  });

  it('suppresses auth-type fallback when credentials identify no provider', () => {
    expect(
      getCatalogModalities(
        {
          openai: {
            models: {
              'shared-model': { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        {
          authType: 'openai',
          modelId: 'shared-model',
          envKey: 'UNKNOWN_API_KEY',
        },
      ),
    ).toBeUndefined();
  });

  it('resolves catalog models through a divergent metadata id', () => {
    expect(
      getCatalogModalities(
        {
          vendor: {
            models: {
              'catalog-key': {
                id: 'runtime-model-id',
                modalities: { input: ['text', 'video'] },
              },
            },
          },
        },
        { providerId: 'vendor', modelId: 'RUNTIME-MODEL-ID' },
      ),
    ).toEqual({ video: true });
  });

  it('selects the model-owning provider when catalog endpoints are shared', () => {
    const sharedApi = 'https://shared.example.com/v1';
    expect(
      getCatalogModalities(
        {
          first: {
            api: sharedApi,
            models: {
              'first-model': { modalities: { input: ['text'] } },
            },
          },
          second: {
            api: sharedApi,
            models: {
              'second-model': { modalities: { input: ['text', 'video'] } },
            },
          },
        },
        { modelId: 'second-model', baseUrl: sharedApi },
      ),
    ).toEqual({ video: true });
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
          alibaba: {
            api: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
            env: ['DASHSCOPE_API_KEY'],
            models: {
              'shared-model': { modalities: { input: ['text'] } },
            },
          },
          'alibaba-cn': {
            api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            env: ['DASHSCOPE_API_KEY'],
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
    ['MiniMax-M3', 'minimax', 'MiniMax-M3'],
    ['kimi-k3', 'moonshotai', 'kimi-k3'],
    ['deepseek-v4-pro', 'deepseek', 'deepseek-v4-pro'],
    ['glm-5.2', 'zai', 'glm-5.2'],
  ])(
    'borrows %s metadata from the %s catalog when the current provider does not list it',
    (modelId, providerId, officialModelId) => {
      expect(
        getCatalogModalities(
          {
            'alibaba-cn': {
              api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              models: {
                'qwen-model': { modalities: { input: ['text'] } },
              },
            },
            [providerId]: {
              models: {
                [officialModelId]: {
                  modalities: { input: ['text', 'image', 'video'] },
                },
              },
            },
          },
          {
            providerId: 'openai',
            modelId,
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            envKey: 'DASHSCOPE_API_KEY',
          },
        ),
      ).toEqual({ image: true, video: true });
    },
  );

  it('resolves an Idealab alias through production-shaped credentials', () => {
    expect(
      getCatalogModalities(
        {
          moonshotai: {
            models: {
              'kimi-k2.6': {
                modalities: { input: ['text', 'image', 'video'] },
              },
            },
          },
        },
        {
          authType: 'openai',
          modelId: 'bailian/kimi-k2.6',
          baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
          envKey: 'IDEALAB_API_KEY',
        },
      ),
    ).toEqual({ image: true, video: true });
  });

  it('borrows original provider metadata for non-Alibaba gateways', () => {
    expect(
      getCatalogModalities(
        {
          gateway: {
            api: 'https://gateway.example.com/v1',
            models: {
              'gateway-model': { modalities: { input: ['text'] } },
            },
          },
          minimax: {
            models: {
              'MiniMax-M3': {
                modalities: { input: ['text', 'image', 'video'] },
              },
            },
          },
        },
        {
          providerId: 'openai',
          modelId: 'MiniMax-M3',
          baseUrl: 'https://gateway.example.com/v1',
          envKey: 'GATEWAY_API_KEY',
        },
      ),
    ).toEqual({ image: true, video: true });
  });

  it('prefers current provider metadata over the original provider catalog', () => {
    expect(
      getCatalogModalities(
        {
          'alibaba-cn': {
            api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            models: {
              'deepseek-v4-pro': { modalities: { input: ['text'] } },
            },
          },
          deepseek: {
            models: {
              'deepseek-v4-pro': {
                modalities: { input: ['text', 'image'] },
              },
            },
          },
        },
        {
          providerId: 'openai',
          modelId: 'deepseek-v4-pro',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ),
    ).toEqual({});
  });

  it('does not borrow an unrelated provider model', () => {
    expect(
      getCatalogModalities(
        {
          'alibaba-cn': {
            api: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            models: {
              'qwen-model': { modalities: { input: ['text'] } },
            },
          },
          minimax: {
            models: {
              'vendor-model': { modalities: { input: ['text', 'image'] } },
            },
          },
        },
        {
          providerId: 'openai',
          modelId: 'vendor-model',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ),
    ).toBeUndefined();
  });

  it.each([
    'vendor/base-model:free',
    'vendor/base-model:batch',
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

  it('prefers exact OpenRouter variant metadata and falls back on unknown suffixes', () => {
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
    // An unrecognized suffix still resolves through the base entry instead of
    // degrading to text-only — variants are open-ended upstream (:batch is
    // currently the most common one).
    expect(
      getCatalogModalities(variantCatalog, {
        providerId: 'openrouter',
        modelId: 'vendor/base-model:unknown',
      }),
    ).toEqual({ image: true });
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
    ['bailian/kimi-k3', 'moonshotai', 'kimi-k3', { image: true, video: true }],
    [
      'bailian/minimax-m3',
      'minimax',
      'MiniMax-M3',
      { image: true, video: true },
    ],
    [
      'bailian/qwen3.8-max',
      'alibaba-cn',
      'qwen3.8-max',
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
              'deepseek-other': {
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
    expect(
      getCatalogModalities(
        {
          minimax: {
            models: {
              'vendor-model': {
                modalities: { input: ['text', 'image'] },
              },
            },
          },
        },
        {
          providerId: 'idealab',
          modelId: 'bailian/vendor-model',
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

  it('keeps valid providers and models from a partially malformed cache', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        valid: {
          models: {
            'valid-model': { modalities: { input: ['text', 'image'] } },
            'attachment-model': { attachment: true },
            malformed: { modalities: {} },
          },
        },
        empty: { models: {} },
        malformed: { models: 'not-an-object' },
      }),
    );

    const loaded = await loadModelMetadataCatalog({
      cachePath,
      fetch: vi.fn(),
    });

    expect(Object.keys(loaded)).toEqual(['valid']);
    expect(
      getCatalogModalities(loaded, {
        providerId: 'valid',
        modelId: 'valid-model',
      }),
    ).toEqual({ image: true });
    expect(
      getCatalogModalities(loaded, {
        providerId: 'valid',
        modelId: 'attachment-model',
      }),
    ).toEqual({ image: true });
    expect(
      getCatalogModalities(loaded, {
        providerId: 'valid',
        modelId: 'malformed',
      }),
    ).toBeUndefined();
  });

  it('safely retains reserved provider and model ids', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    await fs.writeFile(
      cachePath,
      '{"__proto__":{"models":{"__proto__":["text","image"]}}}',
    );

    const loaded = await loadModelMetadataCatalog({
      cachePath,
      fetch: vi.fn(),
    });

    expect(Object.keys(loaded)).toEqual(['__proto__']);
    expect(
      getCatalogModalities(loaded, {
        providerId: '__proto__',
        modelId: '__proto__',
      }),
    ).toEqual({ image: true });
  });

  it('rejects a fresh cache without valid model metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    await fs.writeFile(
      cachePath,
      JSON.stringify({ openrouter: { models: {} } }),
    );
    const fetchMock = vi.fn(async () => {
      throw new Error('offline');
    });

    const loaded = await loadModelMetadataCatalog({
      cachePath,
      fetch: fetchMock,
    });

    expect(Object.keys(loaded).length).toBeGreaterThan(1);
    expect(
      getCatalogModalities(loaded, {
        providerId: 'openai',
        modelId: 'gpt-4o',
      }),
    ).toEqual({ image: true, pdf: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
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

  it('does not resolve inherited provider ids from the built-in snapshot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const loaded = await loadModelMetadataCatalog({
      cachePath: path.join(dir, 'models-dev.json'),
      fetch: async () => {
        throw new Error('offline');
      },
    });

    expect(
      getCatalogModalities(loaded, {
        providerId: 'constructor',
        authType: 'openai',
        modelId: 'kimi-k2.5',
        baseUrl: 'https://gw.example.com/v1',
      }),
    ).toBeUndefined();
  });

  it('pins built-in modalities migrated from provider presets', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const loaded = await loadModelMetadataCatalog({
      cachePath: path.join(dir, 'models-dev.json'),
      fetch: async () => {
        throw new Error('offline');
      },
    });

    const expected = [
      [
        'alibaba-token-plan',
        'qwen3.8-max-preview',
        { image: true, video: true },
      ],
      ['alibaba-token-plan', 'kimi-k2.7-code', { image: true, video: true }],
      ['alibaba-token-plan', 'qwen3.7-plus', { image: true, video: true }],
      ['alibaba-token-plan', 'qwen3.6-plus', { image: true, video: true }],
      ['alibaba-token-plan', 'kimi-k2.5', { image: true, video: true }],
      [
        'alibaba-token-plan-cn',
        'qwen3.8-max-preview',
        { image: true, video: true },
      ],
      ['alibaba-token-plan-cn', 'kimi-k2.7-code', { image: true, video: true }],
      ['alibaba-token-plan-cn', 'qwen3.7-plus', { image: true, video: true }],
      ['alibaba-token-plan-cn', 'qwen3.6-plus', { image: true, video: true }],
      ['alibaba-token-plan-cn', 'kimi-k2.5', { image: true, video: true }],
      ['alibaba-coding-plan', 'qwen3.5-plus', { image: true, video: true }],
      ['alibaba-coding-plan', 'qwen3.6-plus', { image: true, video: true }],
      ['alibaba-coding-plan', 'kimi-k2.5', { image: true, video: true }],
      ['alibaba-coding-plan-cn', 'qwen3.5-plus', { image: true }],
      ['alibaba-coding-plan-cn', 'qwen3.6-plus', { image: true, video: true }],
      ['alibaba-coding-plan-cn', 'kimi-k2.5', { image: true }],
      ['minimax', 'MiniMax-M3', { image: true, video: true }],
    ] as const;

    for (const [providerId, modelId, modalities] of expected) {
      expect(
        getCatalogModalities(loaded, { providerId, modelId }),
        `${providerId}/${modelId}`,
      ).toEqual(modalities);
    }
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

  it.each([
    ['an HTTP error', 500, undefined],
    ['an oversized response body', 200, undefined],
    ['an oversized declared length', 200, String(32 * 1024 * 1024 + 1)],
  ])('keeps the built-in snapshot for %s', async (_name, status, length) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    const cancel = vi.fn();
    const body =
      _name === 'an oversized response body'
        ? JSON.stringify({
            openrouter: {
              models: {
                model: {
                  modalities: { input: ['text'] },
                  padding: 'x'.repeat(32 * 1024 * 1024),
                },
              },
            },
          })
        : JSON.stringify(catalog);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
      },
      cancel,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(stream, {
          status,
          ...(length ? { headers: { 'content-length': length } } : {}),
        }),
    );

    const loaded = await loadModelMetadataCatalog({
      cachePath,
      fetch: fetchMock,
    });

    expect(Object.keys(loaded).length).toBeGreaterThan(1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes fetched metadata when the cache cannot be written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const blockingFile = path.join(dir, 'not-a-directory');
    await fs.writeFile(blockingFile, 'blocked');
    const cachePath = path.join(blockingFile, 'models-dev.json');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(catalog)));

    await loadModelMetadataCatalog({ cachePath, fetch: fetchMock });
    await vi.waitFor(async () => {
      await expect(
        loadModelMetadataCatalog({ cachePath, fetch: fetchMock }),
      ).resolves.toEqual(catalog);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('re-arms an unreferenced hourly refresh on the default path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(catalog)));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await loadModelMetadataCatalog();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await vi.waitFor(async () => {
      await expect(
        fs.readFile(path.join(dir, 'models-dev.json'), 'utf8'),
      ).resolves.toBe(JSON.stringify(catalog));
    });
    await vi.waitFor(() =>
      expect(
        timeoutSpy.mock.calls.some(([, delay]) => delay === 60 * 60 * 1000),
      ).toBe(true),
    );

    const refreshIndex = timeoutSpy.mock.calls.findIndex(
      ([, delay]) => delay === 60 * 60 * 1000,
    );
    const refreshTimer = timeoutSpy.mock.results[refreshIndex]?.value as
      | ReturnType<typeof setTimeout>
      | undefined;
    expect(refreshTimer).toBeDefined();
    expect(refreshTimer?.hasRef()).toBe(false);
    if (refreshTimer) clearTimeout(refreshTimer);
  });

  it('refreshes a fresh default cache when its timer fires', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    await fs.writeFile(cachePath, JSON.stringify(catalog));
    const freshTime = new Date(Date.now() - 60_000);
    await fs.utimes(cachePath, freshTime, freshTime);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(catalog)));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await loadModelMetadataCatalog();
    expect(fetchMock).not.toHaveBeenCalled();
    const refreshIndex = timeoutSpy.mock.calls.findIndex(
      ([, delay]) => typeof delay === 'number' && delay < 60 * 60 * 1000,
    );
    expect(refreshIndex).toBeGreaterThanOrEqual(0);
    const refreshTimer = timeoutSpy.mock.results[refreshIndex]?.value as
      | ReturnType<typeof setTimeout>
      | undefined;
    if (refreshTimer) clearTimeout(refreshTimer);
    const refresh = timeoutSpy.mock.calls[refreshIndex]?.[0];
    expect(refresh).toBeTypeOf('function');
    if (typeof refresh === 'function') refresh();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        timeoutSpy.mock.calls.filter(([, delay]) => delay === 60 * 60 * 1000)
          .length,
      ).toBeGreaterThan(0),
    );
    for (const result of timeoutSpy.mock.results) {
      clearTimeout(result.value as ReturnType<typeof setTimeout>);
    }
  });

  it('re-arms the hourly refresh after refreshing a stale default cache', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    await fs.writeFile(cachePath, JSON.stringify(catalog));
    const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(cachePath, staleTime, staleTime);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(catalog)));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await loadModelMetadataCatalog();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        timeoutSpy.mock.calls.some(([, delay]) => delay === 60 * 60 * 1000),
      ).toBe(true),
    );
    for (const result of timeoutSpy.mock.results) {
      clearTimeout(result.value as ReturnType<typeof setTimeout>);
    }
  });

  it('re-arms the default refresh after a fetch failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('offline'));
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await loadModelMetadataCatalog();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        timeoutSpy.mock.calls.some(([, delay]) => delay === 60 * 60 * 1000),
      ).toBe(true),
    );
    for (const result of timeoutSpy.mock.results) {
      clearTimeout(result.value as ReturnType<typeof setTimeout>);
    }
  });

  it('uses and closes the proxy dispatcher on a successful refresh', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    const undiciFetch = vi.fn(
      async () => new Response(JSON.stringify(catalog)),
    );
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    await loadModelMetadataCatalog({
      cachePath,
      proxyUrl: 'http://proxy.example:8080',
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://proxy.example:8080',
      httpsProxy: 'http://proxy.example:8080',
    });
    expect(undiciFetch).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({
        dispatcher: expect.anything(),
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(
      loadModelMetadataCatalog({
        cachePath,
        proxyUrl: 'http://proxy.example:8080',
      }),
    ).resolves.toEqual(catalog);
  });

  it('normalizes a scheme-less proxy before creating the dispatcher', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: vi.fn(async () => new Response(JSON.stringify(catalog))),
    });

    await loadModelMetadataCatalog({
      cachePath: path.join(dir, 'models-dev.json'),
      proxyUrl: 'localhost:7890',
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(EnvHttpProxyAgent).toHaveBeenCalledWith({
      httpProxy: 'http://localhost:7890',
      httpsProxy: 'http://localhost:7890',
    });
  });

  it('uses the latest proxy options after an in-flight refresh fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    const firstResponse = deferred<Response>();
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const EnvHttpProxyAgent = vi.fn(() => {
      const close = vi.fn(async () => undefined);
      closes.push(close);
      return { close };
    });
    const undiciFetch = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValue(new Response(JSON.stringify(catalog)));
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await vi.waitFor(() => expect(undiciFetch).toHaveBeenCalledOnce());
    await loadModelMetadataCatalog({ proxyUrl: 'second-proxy:8080' });
    firstResponse.resolve(new Response(null, { status: 500 }));

    await vi.waitFor(() => expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(closes).toHaveLength(2);
      for (const close of closes) expect(close).toHaveBeenCalledOnce();
    });
    expect(EnvHttpProxyAgent).toHaveBeenLastCalledWith({
      httpProxy: 'http://second-proxy:8080',
      httpsProxy: 'http://second-proxy:8080',
    });
  });

  it('bounds in-flight proxy handoffs when workspaces alternate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    const undiciFetch = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockResolvedValue(new Response(JSON.stringify(catalog)));
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await vi.waitFor(() => expect(undiciFetch).toHaveBeenCalledOnce());
    await loadModelMetadataCatalog({ proxyUrl: 'second-proxy:8080' });
    firstResponse.resolve(new Response(null, { status: 500 }));
    await vi.waitFor(() => expect(undiciFetch).toHaveBeenCalledTimes(2));

    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    secondResponse.resolve(new Response(null, { status: 500 }));
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(2);

    // After both refreshes settle as failures, further alternating loads must
    // be bounded by the failure backoff instead of starting a new fetch per
    // options change.
    await loadModelMetadataCatalog({ proxyUrl: 'second-proxy:8080' });
    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(2);
  });

  it('backs off after failed refreshes when workspace proxies alternate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    const undiciFetch = vi.fn(async () => {
      throw new Error('proxy offline');
    });
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    await loadModelMetadataCatalog({ proxyUrl: 'second-proxy:8080' });
    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await loadModelMetadataCatalog({ proxyUrl: 'second-proxy:8080' });

    expect(undiciFetch).toHaveBeenCalledOnce();
    expect(EnvHttpProxyAgent).toHaveBeenCalledOnce();

    now += 60 * 60 * 1000;
    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));

    expect(undiciFetch).toHaveBeenCalledTimes(2);
    expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(2);
  });

  it('does not refetch a fresh shared catalog when workspace proxies alternate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    const pendingResponse = deferred<Response>();
    const undiciFetch = vi.fn(() => pendingResponse.promise);
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await loadModelMetadataCatalog({ proxyUrl: 'second-proxy:8080' });
    await loadModelMetadataCatalog({ proxyUrl: 'first-proxy:8080' });
    await loadModelMetadataCatalog({ proxyUrl: 'second-proxy:8080' });
    pendingResponse.resolve(new Response(JSON.stringify(catalog)));
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(undiciFetch).toHaveBeenCalledOnce();
    expect(EnvHttpProxyAgent).toHaveBeenCalledOnce();
  });

  it('keeps a cache-fresh catalog without fetching when proxies alternate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    // Seed a fresh cache file so the initial load succeeds from disk and no
    // refresh attempt is ever recorded — the freshness gate is then the only
    // guard that can stop options-change re-triggers (the failure backoff
    // cannot, because nothing has been attempted).
    await fs.writeFile(
      path.join(dir, 'models-dev.json'),
      JSON.stringify(catalog),
    );
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    const undiciFetch = vi.fn(
      async () => new Response(JSON.stringify(catalog)),
    );
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    const first = await loadModelMetadataCatalog({
      proxyUrl: 'first-proxy:8080',
    });
    const second = await loadModelMetadataCatalog({
      proxyUrl: 'second-proxy:8080',
    });
    const third = await loadModelMetadataCatalog({
      proxyUrl: 'first-proxy:8080',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(EnvHttpProxyAgent).not.toHaveBeenCalled();
  });

  it('disables TLS verification for proxy refreshes when QWEN_TLS_INSECURE is set', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    vi.stubEnv('QWEN_TLS_INSECURE', '1');
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    const undiciFetch = vi.fn(
      async () => new Response(JSON.stringify(catalog)),
    );
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    await loadModelMetadataCatalog({ proxyUrl: 'http://proxy.example:8080' });
    await vi.waitFor(() => expect(undiciFetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(EnvHttpProxyAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        connect: { rejectUnauthorized: false },
        requestTls: { rejectUnauthorized: false },
        proxyTls: { rejectUnauthorized: false },
      }),
    );
  });

  it('disables TLS verification for direct refreshes when QWEN_TLS_INSECURE is set', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(dir);
    vi.stubEnv('QWEN_TLS_INSECURE', '1');
    const close = vi.fn(async () => undefined);
    const Agent = vi.fn(() => ({ close }));
    const undiciFetch = vi.fn(
      async () => new Response(JSON.stringify(catalog)),
    );
    runtimeFetchMock.loadUndici.mockResolvedValue({
      Agent,
      fetch: undiciFetch,
    });

    await loadModelMetadataCatalog({});
    await vi.waitFor(() => expect(undiciFetch).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(Agent).toHaveBeenCalledWith(
      expect.objectContaining({
        connect: { rejectUnauthorized: false },
      }),
    );
  });

  it('closes the proxy dispatcher and keeps the snapshot on rejection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    const close = vi.fn(async () => undefined);
    const EnvHttpProxyAgent = vi.fn(() => ({ close }));
    const undiciFetch = vi.fn(async () => {
      throw new Error('proxy offline');
    });
    runtimeFetchMock.loadUndici.mockResolvedValue({
      EnvHttpProxyAgent,
      fetch: undiciFetch,
    });

    const loaded = await loadModelMetadataCatalog({
      cachePath,
      proxyUrl: 'http://proxy.example:8080',
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(Object.keys(loaded).length).toBeGreaterThan(1);
  });

  it('aborts a hung catalog fetch through the timeout signal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    const timeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutController.signal);
    const fetchMock = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        }),
    );

    await loadModelMetadataCatalog({ cachePath, fetch: fetchMock });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    timeoutController.abort(new DOMException('timed out', 'TimeoutError'));
    await vi.waitFor(() => expect(timeoutController.signal.aborted).toBe(true));

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBe(timeoutController.signal);
  });

  it('does not publish or cache an invalid network catalog', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'models-dev.json');
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ openrouter: {} })),
    );

    const first = await loadModelMetadataCatalog({
      cachePath,
      fetch: fetchMock,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await loadModelMetadataCatalog({
      cachePath,
      fetch: fetchMock,
    });

    expect(second).toBe(first);
    expect(Object.keys(second).length).toBeGreaterThan(1);
    await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
