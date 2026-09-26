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
  getModelCatalogCachePath,
  invalidateModelCatalog,
  lookupModelCatalog,
} from './model-catalog.js';
import {
  MODELS_DEV_URL,
  refreshModelCatalog,
  trimModelsDevCatalog,
  type ModelsDevApi,
} from './model-catalog-refresh.js';

const NOW = '2026-09-16T00:00:00.000Z';
const LONG_AGO = '2000-01-01T00:00:00.000Z';

const chat = (
  id: string,
  limit: { context?: number; input?: number; output?: number },
  input: string[] = ['text'],
) => ({
  id,
  tool_call: true,
  limit,
  modalities: { input, output: ['text'] },
});

const api: ModelsDevApi = {
  anthropic: {
    models: {
      'claude-x': chat('claude-x', { context: 200000, output: 64000 }, [
        'text',
        'image',
        'pdf',
      ]),
    },
  },
  openai: {
    models: {
      'gpt-x': chat(
        'gpt-x',
        { context: 400000, input: 272000, output: 128000 },
        ['text', 'image'],
      ),
      // Not an agent model: no tool calling.
      'embed-x': {
        id: 'embed-x',
        tool_call: false,
        limit: { context: 8192, output: 1 },
        modalities: { input: ['text'], output: ['text'] },
      },
      // Not an agent model: does not answer in text.
      'tts-x': {
        id: 'tts-x',
        tool_call: true,
        limit: { context: 8192, output: 16384 },
        modalities: { input: ['text'], output: ['audio'] },
      },
    },
  },
  zai: {
    models: {
      // Same id as the alibaba-cn entry below, different serving limits.
      'glm-x': chat('glm-x', { context: 204800, output: 131072 }),
    },
  },
  'alibaba-cn': {
    models: {
      'qwen-x': chat('qwen-x', { context: 1000000, output: 65536 }, [
        'text',
        'image',
        'video',
      ]),
      'glm-x': chat('glm-x', { context: 202752, output: 16384 }),
      // Both normalize onto `foo`, neither verbatim, and they disagree.
      'foo-v3': chat('foo-v3', { context: 3000 }),
      'foo-v4': chat('foo-v4', { context: 4000 }),
      // Invalid limits must not become catalog defaults.
      'nothing-known': chat('nothing-known', { context: -1, output: 0 }),
    },
  },
  alibaba: {
    models: {
      'qwen-x': chat('qwen-x', { context: 1000000, output: 65536 }, [
        'text',
        'image',
        'video',
      ]),
    },
  },
  openrouter: {
    models: {
      'router-only': chat('router-only', { context: 9, output: 9 }),
    },
  },
};

const trimmed = {
  'claude-x': {
    context: 200000,
    output: 64000,
    modalities: { image: true, pdf: true },
  },
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

  it('drops conflicts with dated or provider-qualified ids too', () => {
    const models = trimModelsDevCatalog(
      {
        zai: { models: { 'glm-4.6': chat('glm-4.6', { output: 131072 }) } },
        modelscope: {
          models: {
            'ZhipuAI/GLM-4.6': chat('ZhipuAI/GLM-4.6', { output: 98304 }),
          },
        },
        deepseek: {
          models: {
            'deepseek-r1': chat('deepseek-r1', { output: 16384 }),
            'deepseek-r1-0528': chat('deepseek-r1-0528', { output: 32768 }),
          },
        },
      },
      NOW,
    ).models;
    expect(models).not.toHaveProperty('glm-4.6');
    expect(models).not.toHaveProperty('deepseek-r1');
  });

  it('drops an id whose providers disagree instead of picking one', () => {
    // glm-x is served by zai and alibaba-cn with different output limits, so
    // the regex tables keep their current answer.
    expect(trimModelsDevCatalog(api, NOW).models).not.toHaveProperty('glm-x');
  });

  it('drops an id whose aliases disagree and none is verbatim', () => {
    expect(trimModelsDevCatalog(api, NOW).models).not.toHaveProperty('foo');
  });

  it('keeps an id two providers agree on', () => {
    // qwen-x is listed identically by alibaba-cn and alibaba.
    expect(trimModelsDevCatalog(api, NOW).models['qwen-x']).toBeDefined();
  });

  it('drops models that cannot drive an agent turn', () => {
    const models = trimModelsDevCatalog(api, NOW).models;
    expect(models).not.toHaveProperty('embed-x');
    expect(models).not.toHaveProperty('tts-x');
  });

  it('drops a model with no usable field and providers outside the list', () => {
    const models = trimModelsDevCatalog(api, NOW).models;
    expect(models).not.toHaveProperty('nothing-known');
    expect(models).not.toHaveProperty('router-only');
  });

  it('records the source it was trimmed from', () => {
    expect(trimModelsDevCatalog({}, NOW, 'https://mirror/api.json')).toEqual({
      source: 'https://mirror/api.json',
      fetchedAt: NOW,
      models: {},
    });
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
});
