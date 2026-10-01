/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { DefaultOpenAICompatibleProvider } from '../core/openaiContentGenerator/provider/default.js';
import { AuthType } from '../core/contentGenerator.js';
import {
  clampOutputTokensToWindow,
  defaultOutputCeiling,
  hasExplicitOutputLimit,
  tokenLimit,
} from '../core/tokenLimits.js';
import { computeThresholds } from '../services/chatCompressionService.js';
import { resolveModelConfig } from './modelConfigResolver.js';
import bundled from './generated/model-registry.json' with { type: 'json' };
import {
  getModelCatalogCachePath,
  invalidateModelCatalog,
  isModelCatalogKey,
  loadModelCatalog,
  lookupModelCatalog,
  MODEL_CATALOG_PROJECTION_VERSION,
  MODEL_CATALOG_URL_ENV,
  MODELS_DEV_URL,
  parseModelCatalog,
} from './model-catalog.js';

const FAR_FUTURE = '9999-01-01T00:00:00.000Z';
const LONG_AGO = '2000-01-01T00:00:00.000Z';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function writeJson(filePath: string, content: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

describe('model catalog', () => {
  let tempDir: string;
  let previousHome: string | undefined;
  let previousSwitch: string | undefined;
  let previousUrl: string | undefined;
  const [bundledId, bundledEntry] = Object.entries(bundled.models)[0] as [
    string,
    Record<string, unknown>,
  ];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    previousHome = process.env['QWEN_HOME'];
    previousSwitch = process.env['QWEN_CODE_MODELS_DEV'];
    previousUrl = process.env[MODEL_CATALOG_URL_ENV];
    process.env['QWEN_HOME'] = path.join(tempDir, '.qwen');
    delete process.env['QWEN_CODE_MODELS_DEV'];
    delete process.env[MODEL_CATALOG_URL_ENV];
    invalidateModelCatalog();
  });

  afterEach(() => {
    restoreEnv('QWEN_HOME', previousHome);
    restoreEnv('QWEN_CODE_MODELS_DEV', previousSwitch);
    restoreEnv(MODEL_CATALOG_URL_ENV, previousUrl);
    invalidateModelCatalog();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('serves the bundled snapshot when no cache exists', () => {
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
    expect(lookupModelCatalog(bundledId)).toEqual(bundledEntry);
  });

  it('returns undefined for a model the catalog does not list', () => {
    expect(lookupModelCatalog('no-such-model')).toBeUndefined();
  });

  it('is switched off by QWEN_CODE_MODELS_DEV=off', () => {
    process.env['QWEN_CODE_MODELS_DEV'] = 'off';
    expect(lookupModelCatalog(bundledId)).toBeUndefined();
  });

  it('prefers a cache newer than the bundled snapshot', () => {
    writeJson(getModelCatalogCachePath(), {
      source: MODELS_DEV_URL,
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: { 'cached-model': { context: 123, output: 45 } },
    });
    expect(lookupModelCatalog('cached-model')).toEqual({
      context: 123,
      output: 45,
    });
    expect(lookupModelCatalog(bundledId)).toBeUndefined();
  });

  it('ignores a newer cache from a different configured source', () => {
    process.env[MODEL_CATALOG_URL_ENV] = 'https://mirror.example/api.json';
    writeJson(getModelCatalogCachePath(), {
      source: MODELS_DEV_URL,
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: { 'cached-model': { context: 123 } },
    });
    invalidateModelCatalog();

    expect(lookupModelCatalog('cached-model')).toBeUndefined();
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
  });

  it.each([undefined, 0, 2])(
    'ignores a newer cache from another projection (%s)',
    (projection) => {
      writeJson(getModelCatalogCachePath(), {
        source: MODELS_DEV_URL,
        fetchedAt: FAR_FUTURE,
        projection,
        models: { 'deepseek-v4-flash': { modalities: { image: true } } },
      });

      expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
      expect(lookupModelCatalog('deepseek-v4-flash')).toBeUndefined();
      expect(lookupModelCatalog(bundledId)).toEqual(bundledEntry);
    },
  );

  it('ignores a cache older than the bundled snapshot', () => {
    writeJson(getModelCatalogCachePath(), {
      source: 'test',
      fetchedAt: LONG_AGO,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: { 'cached-model': { context: 123 } },
    });
    expect(lookupModelCatalog('cached-model')).toBeUndefined();
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
  });

  it('falls back to the bundled snapshot when the cache is malformed', () => {
    writeJson(getModelCatalogCachePath(), '{not json');
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
    writeJson(getModelCatalogCachePath(), { fetchedAt: FAR_FUTURE });
    invalidateModelCatalog();
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
    // Well-formed, but empty once every entry fails validation: the refresh
    // side already refuses to write this shape, so a stale one must not win.
    writeJson(getModelCatalogCachePath(), {
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: { bad: { context: 'x' } },
    });
    invalidateModelCatalog();
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
    expect(lookupModelCatalog('qwen-flash')).toBeDefined();
  });

  it('uses real bundled defaults without overriding explicit model settings', () => {
    const sources = {
      authType: AuthType.USE_OPENAI,
      cli: {},
      settings: {},
      env: { OPENAI_MODEL: 'qwen-flash' },
    };
    expect(resolveModelConfig(sources).config.contextWindowSize).toBe(
      bundled.models['qwen-flash'].context,
    );
    expect(
      resolveModelConfig({
        ...sources,
        settings: {
          generationConfig: {
            contextWindowSize: 12345,
            modalities: { image: false },
          },
        },
      }).config,
    ).toMatchObject({
      contextWindowSize: 12345,
      modalities: { image: false },
    });
    process.env['QWEN_CODE_MODELS_DEV'] = 'off';
    expect(resolveModelConfig(sources).config.contextWindowSize).toBe(262144);
  });

  it('uses the bundled gpt-4o limit on the env-only configuration path', () => {
    const result = resolveModelConfig({
      authType: AuthType.USE_OPENAI,
      cli: {},
      settings: {},
      env: {
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'http://localhost:8000/v1',
        OPENAI_MODEL: 'gpt-4o',
      },
    });

    expect(result.config.contextWindowSize).toBe(128_000);
    expect(result.sources['contextWindowSize'].kind).toBe('computed');
  });

  it('preserves existing output limits across the entire bundled snapshot', () => {
    for (const id of Object.keys(bundled.models)) {
      process.env['QWEN_CODE_MODELS_DEV'] = 'off';
      const pinned = hasExplicitOutputLimit(id);
      const previous = tokenLimit(id, 'output');
      delete process.env['QWEN_CODE_MODELS_DEV'];
      if (pinned) {
        expect({ id, output: tokenLimit(id, 'output') }).toEqual({
          id,
          output: previous,
        });
      }
    }
    expect(defaultOutputCeiling('glm-4.7')).toBe(16_384);
    expect(tokenLimit('qwen-vl-max', 'output')).toBe(32_768);
    expect(tokenLimit('claude-sonnet-4-6')).toBe(1_000_000);
    expect(tokenLimit('claude-sonnet-5')).toBe(1_000_000);
  });

  it('keeps bundled automatic windows safe at the compaction threshold', () => {
    const unsafe: Array<{ id: string; total: number; window: number }> = [];
    for (const id of Object.keys(bundled.models)) {
      const window = tokenLimit(id);
      const prompt = computeThresholds(window).auto;
      const output = clampOutputTokensToWindow(
        defaultOutputCeiling(id),
        window,
        prompt,
      );
      if (prompt + output > window) {
        unsafe.push({ id, total: prompt + output, window });
      }
    }
    expect(unsafe).toEqual([]);
    expect(tokenLimit('gpt-4-1106-preview')).toBe(131_072);
    expect(tokenLimit('qwen-math-plus')).toBe(262_144);
  });

  it('ships the current modality-only projection for offline startup', () => {
    expect(lookupModelCatalog('inkling')).toEqual({
      modalities: { image: true },
    });
  });

  it('keys every bundled entry by a usable model id', () => {
    for (const id of Object.keys(bundled.models)) {
      expect(isModelCatalogKey(id)).toBe(true);
    }
    // Both spellings of a model must resolve alike; a dated alias must not
    // land on a key the canonical id cannot reach (deepseek-v3 did).
    expect(lookupModelCatalog('deepseek-v3-0324')).toBeUndefined();
  });

  it('drops cache keys no normalized spelling can reach', () => {
    // A cache written before the projection's fixed-point filter can carry
    // `deepseek-v3`; its own normalized spelling (deepseek) never reaches it,
    // while it poisons every dated alias that resolves through the lookup.
    writeJson(getModelCatalogCachePath(), {
      source: 'https://models.dev/api.json',
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: { 'deepseek-v3': { context: 163_840, output: 163_840 } },
    });
    invalidateModelCatalog();
    expect(lookupModelCatalog('deepseek-v3')).toBeUndefined();
    expect(tokenLimit('deepseek-v3-0324', 'output')).toBe(32_000);
  });

  it('drops lossy and generic keys from an older cache', () => {
    writeJson(getModelCatalogCachePath(), {
      source: MODELS_DEV_URL,
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: {
        '32768': { modalities: { pdf: true } },
        'model@default': { context: 123 },
        auto: { modalities: { image: true } },
        'valid-model': { context: 456 },
      },
    });
    invalidateModelCatalog();
    expect(lookupModelCatalog('32768')).toBeUndefined();
    expect(lookupModelCatalog('model@default')).toBeUndefined();
    expect(lookupModelCatalog('auto')).toBeUndefined();
    expect(lookupModelCatalog('valid-model')).toEqual({ context: 456 });
  });

  it('keeps output pins after refresh while filling unknown model limits', () => {
    writeJson(getModelCatalogCachePath(), {
      source: 'https://models.dev/api.json',
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: {
        'glm-4.7': { output: 131_072 },
        'qwen-vl-max': { output: 8_192 },
        'new-model': { context: 200_000, output: 8_000 },
      },
    });
    invalidateModelCatalog();
    expect(defaultOutputCeiling('glm-4.7')).toBe(16_384);
    expect(tokenLimit('qwen-vl-max', 'output')).toBe(32_768);
    expect(tokenLimit('new-model', 'output')).toBe(8_000);
    expect(hasExplicitOutputLimit('new-model')).toBe(false);
  });

  it('uses catalog output defaults without clipping explicit provider requests', () => {
    const previous = process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];
    try {
      for (const [model, defaultTokens] of [
        ['qwq-32b', 8_192],
        ['kimi-k2-thinking', 16_384],
        ['qvq-max', 8_192],
      ] as const) {
        const provider = new DefaultOpenAICompatibleProvider(
          { model },
          {} as Config,
        );
        const request = { model, messages: [] };
        delete process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];
        expect(provider.buildRequest(request, 'test').max_tokens).toBe(
          defaultTokens,
        );
        expect(
          provider.buildRequest({ ...request, max_tokens: 32_768 }, 'test')
            .max_tokens,
        ).toBe(32_768);
        process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'] = '32768';
        expect(provider.buildRequest(request, 'test').max_tokens).toBe(32_768);
      }
      // The only case where the explicit env budget exceeds a curated pin,
      // so the isKnownModel clamp must win over the env value.
      process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'] = '32768';
      const provider = new DefaultOpenAICompatibleProvider(
        { model: 'glm-4.7' },
        {} as Config,
      );
      expect(
        provider.buildRequest({ model: 'glm-4.7', messages: [] }, 'test')
          .max_tokens,
      ).toBe(16_384);
    } finally {
      restoreEnv('QWEN_CODE_MAX_OUTPUT_TOKENS', previous);
    }
  });

  it('requires explicit Qwen PDF support for both bundled and refreshed data', () => {
    const sources = {
      authType: AuthType.USE_OPENAI,
      cli: {},
      settings: {},
      env: { OPENAI_MODEL: 'qwen3.8-max' },
    };
    expect(resolveModelConfig(sources).config.modalities).toMatchObject({
      image: true,
      video: true,
    });
    expect(resolveModelConfig(sources).config.modalities?.pdf).toBeUndefined();
    writeJson(getModelCatalogCachePath(), {
      source: 'https://models.dev/api.json',
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: { 'qwen3.8-max': { modalities: { image: true, pdf: true } } },
    });
    invalidateModelCatalog();
    expect(resolveModelConfig(sources).config.modalities?.pdf).toBeUndefined();
    expect(
      resolveModelConfig({
        ...sources,
        settings: { generationConfig: { modalities: { pdf: true } } },
      }).config.modalities?.pdf,
    ).toBe(true);
  });

  it('keeps Sonnet 4.5 at its default API limit even after a refresh', () => {
    expect(lookupModelCatalog('claude-sonnet-4-5')?.context).toBe(200_000);
    writeJson(getModelCatalogCachePath(), {
      source: 'https://models.dev/api.json',
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: {
        'claude-sonnet-4-5': { context: 1_000_000, output: 64_000 },
        'claude-sonnet-4-6': { context: 1_000_000 },
      },
    });
    invalidateModelCatalog();
    expect(lookupModelCatalog('claude-sonnet-4-5')).toEqual({
      context: 200_000,
      output: 64_000,
    });
    expect(lookupModelCatalog('claude-sonnet-4-6')?.context).toBe(1_000_000);
  });

  it('keeps qwen3-coder-plus at its vendor-declared 1M window even after a refresh', () => {
    expect(tokenLimit('qwen3-coder-plus')).toBe(1_000_000);
    expect(
      computeThresholds(tokenLimit('qwen3-coder-plus')).hard,
    ).toBeLessThanOrEqual(1_000_000);
    writeJson(getModelCatalogCachePath(), {
      source: 'https://models.dev/api.json',
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      models: { 'qwen3-coder-plus': { context: 1_048_576, output: 65_536 } },
    });
    invalidateModelCatalog();
    expect(lookupModelCatalog('qwen3-coder-plus')).toEqual({
      context: 1_000_000,
      output: 65_536,
    });
    expect(tokenLimit('qwen3-coder-plus')).toBe(1_000_000);
  });

  // models.dev buckets each of these above the window the curated table in
  // tokenLimits.ts and the provider presets declare, so the declared value
  // must survive both the bundled snapshot and a newer downloaded one.
  it.each([
    ['kimi-k3', 1_000_000],
    ['minimax-m2.5', 196_608],
    ['minimax-m2.5-highspeed', 196_608],
    ['glm-4.7', 202_752],
  ])(
    'keeps %s at its declared %i window even after a refresh',
    (id, declared) => {
      expect(tokenLimit(id)).toBe(declared);
      expect(computeThresholds(tokenLimit(id)).hard).toBeLessThanOrEqual(
        declared,
      );
      writeJson(getModelCatalogCachePath(), {
        source: 'https://models.dev/api.json',
        fetchedAt: FAR_FUTURE,
        projection: MODEL_CATALOG_PROJECTION_VERSION,
        models: { [id]: { context: declared + 48_576, output: 65_536 } },
      });
      invalidateModelCatalog();
      expect(lookupModelCatalog(id)?.context).toBe(declared);
      expect(tokenLimit(id)).toBe(declared);
    },
  );

  it('drops malformed entries while parsing', () => {
    const parsed = parseModelCatalog({
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      etag: '"abc"',
      models: {
        good: { context: 1, modalities: { image: true } },
        bad: { context: 'x' },
        worse: null,
        negative: { context: -1 },
        zero: { output: 0 },
        infinite: { context: Infinity },
        fractional: { output: 1.5 },
        // A wrong-typed or false flag drops only the modality field — the
        // entry's limits survive a malformed modalities member.
        invalidModality: { context: 5, modalities: { image: 'false' } },
        falseModality: { context: 6, modalities: { image: false } },
        // A modality key this build does not know (e.g. written by a newer
        // one) degrades that field, not the whole entry.
        futureModality: {
          context: 100,
          output: 10,
          modalities: { image: true, hologram: true },
        },
        // An own-property `__proto__` key (the refresh path can legitimately
        // write one via Object.fromEntries; a literal would invoke the setter
        // here, so it comes in through spread). The parse must skip it rather
        // than mutate the map's prototype.
        ...Object.fromEntries([['__proto__', { context: 1 }]]),
      },
    });
    expect(parsed).toEqual({
      source: '',
      fetchedAt: FAR_FUTURE,
      projection: MODEL_CATALOG_PROJECTION_VERSION,
      etag: '"abc"',
      models: {
        good: { context: 1, modalities: { image: true } },
        invalidModality: { context: 5, modalities: {} },
        falseModality: { context: 6, modalities: {} },
        futureModality: {
          context: 100,
          output: 10,
          modalities: { image: true },
        },
      },
    });
    expect(Object.getPrototypeOf(parsed!.models)).toBe(Object.prototype);
    expect(parseModelCatalog({ models: {} })).toBeUndefined();
    expect(parseModelCatalog('nope')).toBeUndefined();
  });

  it('keeps every entry of the committed snapshot parseable', () => {
    // The bundled file is the floor every offline user starts from, so it
    // must satisfy the same parser the downloaded cache goes through.
    const parsed = parseModelCatalog(bundled);
    expect(parsed).toBeDefined();
    expect(Object.keys(parsed!.models).sort()).toEqual(
      Object.keys(bundled.models).sort(),
    );
    expect(Buffer.byteLength(JSON.stringify(bundled))).toBeLessThanOrEqual(
      200 * 1024,
    );
  });

  it('stamps the committed snapshot with the canonical catalog URL', () => {
    // Provenance must name where the data comes from, not the local path a
    // maintainer happened to generate from (scripts/generate-model-catalog.ts
    // stamps MODELS_DEV_URL for local-path inputs).
    expect(bundled.source).toBe(MODELS_DEV_URL);
  });
});
