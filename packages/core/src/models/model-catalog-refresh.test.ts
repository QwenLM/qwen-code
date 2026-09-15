/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCustomModelCatalogCachePath,
  getModelCatalogCachePath,
  invalidateModelCatalog,
  lookupModelCatalog,
  setCustomModelCatalogSource,
} from './model-catalog.js';
import {
  MODELS_DEV_URL,
  projectCustomCatalog,
  refreshModelCatalog,
  trimModelsDevCatalog,
  type ModelsDevApi,
} from './model-catalog-refresh.js';

const NOW = '2026-09-16T00:00:00.000Z';
const LONG_AGO = '2000-01-01T00:00:00.000Z';

const api: ModelsDevApi = {
  anthropic: {
    models: {
      'claude-x': {
        id: 'claude-x',
        limit: { context: 200000, output: 64000 },
        modalities: { input: ['text', 'image', 'pdf'] },
      },
    },
  },
  openai: {
    models: {
      'gpt-x': {
        id: 'gpt-x',
        limit: { context: 400000, input: 272000, output: 128000 },
        modalities: { input: ['text', 'image'] },
      },
    },
  },
  'alibaba-cn': {
    models: {
      'qwen-x': {
        id: 'qwen-x',
        limit: { context: 1000000, output: 65536 },
        modalities: { input: ['text', 'image', 'video'] },
      },
      'qwen-x-20260101': {
        id: 'qwen-x-20260101',
        limit: { context: 1, output: 1 },
      },
      'foo-v3': {
        id: 'foo-v3',
        release_date: '2025-01-01',
        limit: { context: 3000 },
      },
      'image-only': {
        id: 'image-only',
        limit: { context: 0, output: 0 },
        modalities: { input: ['text'] },
      },
    },
  },
  alibaba: {
    models: {
      'qwen-x': { id: 'qwen-x', limit: { context: 2, output: 2 } },
      'foo-v4': {
        id: 'foo-v4',
        release_date: '2026-01-01',
        limit: { context: 4000 },
      },
    },
  },
  openrouter: {
    models: {
      'router-only': { id: 'router-only', limit: { context: 9, output: 9 } },
    },
  },
};

const trimmed = {
  'claude-x': {
    context: 200000,
    output: 64000,
    modalities: { image: true, pdf: true },
  },
  foo: { context: 4000 },
  'gpt-x': { context: 272000, output: 128000, modalities: { image: true } },
  'qwen-x': {
    context: 1000000,
    output: 65536,
    modalities: { image: true, video: true },
  },
};

const ENV_NAMES = [
  'QWEN_HOME',
  'QWEN_CODE_MODELS_DEV',
  'QWEN_CODE_MODELS_DEV_REFRESH',
  'QWEN_CODE_MODELS_DEV_URL',
];

describe('trimModelsDevCatalog', () => {
  it('keeps only limits and modalities from first-party providers, keyed by normalized id', () => {
    expect(trimModelsDevCatalog(api, NOW)).toEqual({
      source: MODELS_DEV_URL,
      fetchedAt: NOW,
      models: trimmed,
    });
  });

  it('records the source it was trimmed from', () => {
    expect(trimModelsDevCatalog({}, NOW, 'https://mirror/api.json')).toEqual({
      source: 'https://mirror/api.json',
      fetchedAt: NOW,
      models: {},
    });
  });
});

describe('projectCustomCatalog', () => {
  it('normalizes the ids of a trimmed-shape document and drops bad entries', () => {
    expect(
      projectCustomCatalog(
        {
          models: {
            'Qwen3.9-Max': { context: 42, modalities: { image: true } },
            'openai/gpt-y:free': { output: 7 },
            broken: { context: 'x' },
          },
        },
        NOW,
        '/etc/qwen/models.json',
      ),
    ).toEqual({
      source: '/etc/qwen/models.json',
      fetchedAt: NOW,
      models: {
        'gpt-y': { output: 7 },
        'qwen3.9-max': { context: 42, modalities: { image: true } },
      },
    });
  });

  it('reads every provider of a models.dev-shape document', () => {
    expect(
      projectCustomCatalog(
        {
          ...api,
          'my-gateway': {
            models: {
              'my-model': { id: 'my-model', limit: { context: 7, output: 8 } },
            },
          },
        },
        NOW,
        'https://intranet/models.json',
      ).models,
    ).toEqual({
      ...trimmed,
      'my-model': { context: 7, output: 8 },
      'router-only': { context: 9, output: 9 },
    });
  });

  it('yields an empty catalog for a document of neither shape', () => {
    expect(projectCustomCatalog(null, NOW, 'x').models).toEqual({});
    expect(projectCustomCatalog('text', NOW, 'x').models).toEqual({});
  });
});

describe('refreshModelCatalog', () => {
  let tempDir: string;
  let previousEnv: Record<string, string | undefined>;
  const fetchMock = vi.fn<typeof fetch>();

  function jsonResponse(
    body: unknown,
    headers: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify(body), { status: 200, headers });
  }

  function readJson(filePath: string): {
    source: string;
    fetchedAt: string;
    etag?: string;
    models: unknown;
  } {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  function writeJson(filePath: string, content: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(content));
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    previousEnv = Object.fromEntries(
      ENV_NAMES.map((name) => [name, process.env[name]]),
    );
    for (const name of ENV_NAMES) {
      delete process.env[name];
    }
    process.env['QWEN_HOME'] = path.join(tempDir, '.qwen');
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setCustomModelCatalogSource(undefined);
    invalidateModelCatalog();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const name of ENV_NAMES) {
      const value = previousEnv[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    setCustomModelCatalogSource(undefined);
    invalidateModelCatalog();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the trimmed catalog to the cache and serves it immediately', async () => {
    fetchMock.mockResolvedValue(jsonResponse(api, { etag: '"abc"' }));

    await refreshModelCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(MODELS_DEV_URL);
    const cache = readJson(getModelCatalogCachePath());
    expect(cache.source).toBe(MODELS_DEV_URL);
    expect(cache.etag).toBe('"abc"');
    expect(cache.models).toEqual(trimmed);
    expect(lookupModelCatalog('qwen-x')).toEqual(trimmed['qwen-x']);
  });

  it('skips the network while the cache is fresh', async () => {
    writeJson(getModelCatalogCachePath(), {
      source: MODELS_DEV_URL,
      fetchedAt: new Date().toISOString(),
      models: {},
    });

    await refreshModelCatalog();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-fetches a fresh cache that came from a different URL', async () => {
    writeJson(getModelCatalogCachePath(), {
      source: 'https://old-mirror/api.json',
      fetchedAt: new Date().toISOString(),
      etag: '"old"',
      models: {},
    });
    fetchMock.mockResolvedValue(jsonResponse(api));

    await refreshModelCatalog();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({});
    expect(readJson(getModelCatalogCachePath()).source).toBe(MODELS_DEV_URL);
  });

  it('revalidates a stale cache with its ETag and keeps the models on 304', async () => {
    writeJson(getModelCatalogCachePath(), {
      source: MODELS_DEV_URL,
      fetchedAt: LONG_AGO,
      etag: '"abc"',
      models: { kept: { context: 7 } },
    });
    fetchMock.mockResolvedValue(new Response(null, { status: 304 }));

    await refreshModelCatalog();

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'If-None-Match': '"abc"',
    });
    const cache = readJson(getModelCatalogCachePath());
    expect(cache.models).toEqual({ kept: { context: 7 } });
    expect(cache.etag).toBe('"abc"');
    expect(Date.parse(cache.fetchedAt)).toBeGreaterThan(Date.parse(LONG_AGO));
  });

  it('leaves the cache untouched when the fetch fails', async () => {
    writeJson(getModelCatalogCachePath(), {
      source: MODELS_DEV_URL,
      fetchedAt: LONG_AGO,
      models: { kept: { context: 7 } },
    });
    fetchMock.mockRejectedValue(new Error('offline'));

    await expect(refreshModelCatalog()).resolves.toBeUndefined();

    expect(readJson(getModelCatalogCachePath()).fetchedAt).toBe(LONG_AGO);
  });

  it('leaves the cache untouched on an HTTP error', async () => {
    writeJson(getModelCatalogCachePath(), {
      source: MODELS_DEV_URL,
      fetchedAt: LONG_AGO,
      models: {},
    });
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));

    await refreshModelCatalog();

    expect(readJson(getModelCatalogCachePath()).fetchedAt).toBe(LONG_AGO);
  });

  it('does nothing when the refresh or the whole catalog is switched off', async () => {
    process.env['QWEN_CODE_MODELS_DEV_REFRESH'] = 'off';
    await refreshModelCatalog();
    delete process.env['QWEN_CODE_MODELS_DEV_REFRESH'];
    process.env['QWEN_CODE_MODELS_DEV'] = 'off';
    await refreshModelCatalog();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches from QWEN_CODE_MODELS_DEV_URL when set', async () => {
    process.env['QWEN_CODE_MODELS_DEV_URL'] = 'https://mirror.example/api.json';
    fetchMock.mockResolvedValue(jsonResponse(api));

    await refreshModelCatalog();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://mirror.example/api.json',
    );
    expect(readJson(getModelCatalogCachePath()).source).toBe(
      'https://mirror.example/api.json',
    );
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    fetchMock.mockResolvedValue(jsonResponse(api));

    await Promise.all([refreshModelCatalog(), refreshModelCatalog()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('materializes a local custom catalog before returning and merges it', async () => {
    const file = path.join(tempDir, 'custom.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        models: { 'Qwen3.9-Max': { context: 42, modalities: { image: true } } },
      }),
    );
    process.env['QWEN_CODE_MODELS_DEV_REFRESH'] = 'off';

    const pending = refreshModelCatalog(file);
    expect(lookupModelCatalog('qwen3.9-max')).toEqual({
      context: 42,
      modalities: { image: true },
    });
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readJson(getCustomModelCatalogCachePath()).source).toBe(file);
  });

  it('keeps going when the local custom catalog is unreadable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(api));

    await refreshModelCatalog(path.join(tempDir, 'missing.json'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(getCustomModelCatalogCachePath())).toBe(false);
    expect(lookupModelCatalog('qwen-x')).toEqual(trimmed['qwen-x']);
  });

  it('downloads a custom catalog URL even when the models.dev refresh is off', async () => {
    process.env['QWEN_CODE_MODELS_DEV_REFRESH'] = 'off';
    fetchMock.mockResolvedValue(
      jsonResponse({ models: { 'remote-model': { output: 9 } } }),
    );

    await refreshModelCatalog('https://intranet.example/models.json');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://intranet.example/models.json',
    );
    expect(lookupModelCatalog('remote-model')).toEqual({ output: 9 });
    expect(fs.existsSync(getModelCatalogCachePath())).toBe(false);
  });

  it('refreshes models.dev and the custom URL in one pass', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(api))
      .mockResolvedValueOnce(
        jsonResponse({ models: { 'qwen-x': { output: 1 } } }),
      );

    await refreshModelCatalog('https://intranet.example/models.json');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      MODELS_DEV_URL,
      'https://intranet.example/models.json',
    ]);
    expect(lookupModelCatalog('qwen-x')).toEqual({
      ...trimmed['qwen-x'],
      output: 1,
    });
  });
});
