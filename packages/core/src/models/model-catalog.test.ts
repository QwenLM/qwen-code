/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import bundled from './generated/model-registry.json' with { type: 'json' };
import {
  getModelCatalogCachePath,
  invalidateModelCatalog,
  loadModelCatalog,
  lookupModelCatalog,
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

describe('model catalog', () => {
  let tempDir: string;
  let previousHome: string | undefined;
  let previousSwitch: string | undefined;
  const [bundledId, bundledEntry] = Object.entries(bundled.models)[0] as [
    string,
    unknown,
  ];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-catalog-'));
    previousHome = process.env['QWEN_HOME'];
    previousSwitch = process.env['QWEN_CODE_MODELS_DEV'];
    process.env['QWEN_HOME'] = path.join(tempDir, '.qwen');
    delete process.env['QWEN_CODE_MODELS_DEV'];
    invalidateModelCatalog();
  });

  afterEach(() => {
    restoreEnv('QWEN_HOME', previousHome);
    restoreEnv('QWEN_CODE_MODELS_DEV', previousSwitch);
    invalidateModelCatalog();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeCache(catalog: unknown): void {
    const cachePath = getModelCatalogCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      typeof catalog === 'string' ? catalog : JSON.stringify(catalog),
    );
  }

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
    writeCache({
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
    writeCache({
      source: 'test',
      fetchedAt: LONG_AGO,
      models: { 'cached-model': { context: 123 } },
    });
    expect(lookupModelCatalog('cached-model')).toBeUndefined();
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
  });

  it('falls back to the bundled snapshot when the cache is malformed', () => {
    writeCache('{not json');
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
    writeCache({ fetchedAt: FAR_FUTURE });
    invalidateModelCatalog();
    expect(loadModelCatalog().fetchedAt).toBe(bundled.fetchedAt);
  });

  it('drops malformed entries while parsing', () => {
    const parsed = parseModelCatalog({
      fetchedAt: FAR_FUTURE,
      etag: '"abc"',
      models: {
        good: { context: 1, modalities: { image: true } },
        bad: { context: 'x' },
        worse: null,
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
