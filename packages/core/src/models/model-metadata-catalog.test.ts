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

  it('fetches and caches the catalog when no cache exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);
    const cachePath = path.join(dir, 'nested', 'models-dev.json');
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(catalog), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(
      loadModelMetadataCatalog({ cachePath, fetch: fetchMock }),
    ).resolves.toEqual(catalog);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(fs.readFile(cachePath, 'utf8')).resolves.toBe(
      JSON.stringify(catalog),
    );
  });

  it('returns an empty catalog when cache and network are unavailable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'models-dev-test-'));
    tempDirs.push(dir);

    await expect(
      loadModelMetadataCatalog({
        cachePath: path.join(dir, 'models-dev.json'),
        fetch: async () => {
          throw new Error('offline');
        },
      }),
    ).resolves.toEqual({});
  });
});
