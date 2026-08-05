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
