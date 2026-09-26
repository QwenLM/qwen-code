/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import { resolveModelConfig } from './modelConfigResolver.js';
import bundled from './generated/model-registry.json' with { type: 'json' };
import {
  getCustomModelCatalogCachePath,
  getModelCatalogCachePath,
  invalidateModelCatalog,
  loadModelCatalog,
  lookupModelCatalog,
  parseModelCatalog,
  setCustomModelCatalogSource,
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
  const [bundledId, bundledEntry] = Object.entries(bundled.models)[0] as [
    string,
    Record<string, unknown>,
  ];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    previousHome = process.env['QWEN_HOME'];
    previousSwitch = process.env['QWEN_CODE_MODELS_DEV'];
    process.env['QWEN_HOME'] = path.join(tempDir, '.qwen');
    delete process.env['QWEN_CODE_MODELS_DEV'];
    setCustomModelCatalogSource(undefined);
    invalidateModelCatalog();
  });

  afterEach(() => {
    restoreEnv('QWEN_HOME', previousHome);
    restoreEnv('QWEN_CODE_MODELS_DEV', previousSwitch);
    setCustomModelCatalogSource(undefined);
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
      source: 'test',
      fetchedAt: FAR_FUTURE,
      models: { 'cached-model': { context: 123, output: 45 } },
    });
    expect(lookupModelCatalog('cached-model')).toEqual({
      context: 123,
      output: 45,
    });
    expect(lookupModelCatalog(bundledId)).toBeUndefined();
  });

  it('ignores a cache older than the bundled snapshot', () => {
    writeJson(getModelCatalogCachePath(), {
      source: 'test',
      fetchedAt: LONG_AGO,
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
  });

  it('layers the custom catalog over the base per model and field', () => {
    writeJson(getCustomModelCatalogCachePath(), {
      source: '/etc/qwen/models.json',
      fetchedAt: LONG_AGO,
      models: {
        [bundledId]: { context: 1 },
        'custom-model': { output: 2 },
      },
    });
    setCustomModelCatalogSource('/etc/qwen/models.json');

    expect(lookupModelCatalog(bundledId)).toEqual({
      ...bundledEntry,
      context: 1,
    });
    expect(lookupModelCatalog('custom-model')).toEqual({ output: 2 });
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
  });

  it('ignores a custom cache whose source no longer matches the setting', () => {
    writeJson(getCustomModelCatalogCachePath(), {
      source: '/etc/qwen/old.json',
      fetchedAt: LONG_AGO,
      models: { 'custom-model': { output: 2 } },
    });

    setCustomModelCatalogSource('/etc/qwen/new.json');
    expect(lookupModelCatalog('custom-model')).toBeUndefined();

    setCustomModelCatalogSource(undefined);
    expect(lookupModelCatalog('custom-model')).toBeUndefined();

    setCustomModelCatalogSource('/etc/qwen/old.json');
    expect(lookupModelCatalog('custom-model')).toEqual({ output: 2 });
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

  it('keeps Sonnet 4.5 at its default API limit even after a refresh', () => {
    expect(lookupModelCatalog('claude-sonnet-4-5')?.context).toBe(200_000);
    writeJson(getModelCatalogCachePath(), {
      source: 'https://models.dev/api.json',
      fetchedAt: FAR_FUTURE,
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

  it('drops malformed entries while parsing', () => {
    const parsed = parseModelCatalog({
      fetchedAt: FAR_FUTURE,
      etag: '"abc"',
      models: {
        good: { context: 1, modalities: { image: true } },
        bad: { context: 'x' },
        worse: null,
        negative: { context: -1 },
        zero: { output: 0 },
        infinite: { context: Infinity },
        fractional: { output: 1.5 },
        invalidModality: { modalities: { image: 'false' } },
      },
    });
    expect(parsed).toEqual({
      source: '',
      fetchedAt: FAR_FUTURE,
      etag: '"abc"',
      models: { good: { context: 1, modalities: { image: true } } },
    });
    expect(parseModelCatalog({ models: {} })).toBeUndefined();
    expect(parseModelCatalog('nope')).toBeUndefined();
  });
});
