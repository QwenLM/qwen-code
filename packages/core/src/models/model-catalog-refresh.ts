/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InputModalities } from '../core/contentGenerator.js';
import { normalize } from '../core/tokenLimits.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  getModelCatalogCachePath,
  invalidateModelCatalog,
  isModelCatalogDisabled,
  parseModelCatalog,
  type ModelCatalog,
  type ModelCatalogEntry,
} from './model-catalog.js';

const debugLogger = createDebugLogger('MODEL_CATALOG');

export const MODELS_DEV_URL = 'https://models.dev/api.json';
/** `QWEN_CODE_MODELS_DEV_REFRESH=off` keeps the bundled snapshot and never fetches. */
export const MODEL_CATALOG_REFRESH_ENV = 'QWEN_CODE_MODELS_DEV_REFRESH';
/** Replaces the models.dev URL, e.g. with a corporate mirror. */
export const MODEL_CATALOG_URL_ENV = 'QWEN_CODE_MODELS_DEV_URL';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * models.dev providers whose entries feed the catalog, in priority order: a
 * model id served by several of them takes the first provider's numbers.
 * Third-party routers are left out — they republish vendor models under
 * their own aliases and limits.
 */
export const MODELS_DEV_PROVIDERS: readonly string[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'moonshotai',
  'zai',
  'minimax',
  'xai',
  'alibaba-cn',
  'alibaba',
  'modelscope',
  'volcengine',
];

interface ModelsDevModel {
  id: string;
  release_date?: string;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[] };
}

export type ModelsDevApi = Record<
  string,
  { models?: Record<string, ModelsDevModel> } | undefined
>;

const MODALITIES: ReadonlyArray<keyof InputModalities> = [
  'image',
  'pdf',
  'audio',
  'video',
];

function toEntry(model: ModelsDevModel): ModelCatalogEntry | undefined {
  const entry: ModelCatalogEntry = {};
  const context = model.limit?.input || model.limit?.context;
  if (context) {
    entry.context = context;
  }
  if (model.limit?.output) {
    entry.output = model.limit.output;
  }
  const modalities: InputModalities = {};
  for (const modality of MODALITIES) {
    if (model.modalities?.input?.includes(modality)) {
      modalities[modality] = true;
    }
  }
  if (Object.keys(modalities).length > 0) {
    entry.modalities = modalities;
  }
  return Object.keys(entry).length > 0 ? entry : undefined;
}

/**
 * Projects a models.dev `api.json` payload onto the catalog shape: one entry
 * per normalized model id with only the fields the limit and modality
 * tables consume. An id that is its own normalized form (`qwen3-max`) beats
 * one that collapses onto it (`qwen3-max-20260123`); among collapsed
 * aliases the newest release wins.
 */
export function trimModelsDevCatalog(
  api: ModelsDevApi,
  fetchedAt: string,
  source: string = MODELS_DEV_URL,
): ModelCatalog {
  const picked = new Map<
    string,
    { exact: boolean; releaseDate: string; entry: ModelCatalogEntry }
  >();
  for (const provider of MODELS_DEV_PROVIDERS) {
    for (const model of Object.values(api[provider]?.models ?? {})) {
      if (typeof model.id !== 'string') {
        continue;
      }
      const key = normalize(model.id);
      const exact = key === model.id.toLowerCase();
      const releaseDate = model.release_date ?? '';
      const previous = picked.get(key);
      if (
        previous &&
        (previous.exact || (!exact && releaseDate <= previous.releaseDate))
      ) {
        continue;
      }
      const entry = toEntry(model);
      if (entry) {
        picked.set(key, { exact, releaseDate, entry });
      }
    }
  }
  const models: Record<string, ModelCatalogEntry> = {};
  for (const [key, { entry }] of [...picked].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    models[key] = entry;
  }
  return { source, fetchedAt, models };
}

async function readCacheFile(
  cachePath: string,
): Promise<ModelCatalog | undefined> {
  try {
    return parseModelCatalog(JSON.parse(await fs.readFile(cachePath, 'utf8')));
  } catch {
    return undefined;
  }
}

async function fetchAndStore(): Promise<void> {
  const cachePath = getModelCatalogCachePath();
  const cached = await readCacheFile(cachePath);
  if (
    cached &&
    Date.now() - Date.parse(cached.fetchedAt) < REFRESH_INTERVAL_MS
  ) {
    return;
  }
  const url = process.env[MODEL_CATALOG_URL_ENV] || MODELS_DEV_URL;
  const headers: Record<string, string> = {};
  if (cached?.etag) {
    headers['If-None-Match'] = cached.etag;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const fetchedAt = new Date().toISOString();
  let next: ModelCatalog;
  if (response.status === 304 && cached) {
    next = { ...cached, fetchedAt };
  } else if (response.ok) {
    next = trimModelsDevCatalog(
      (await response.json()) as ModelsDevApi,
      fetchedAt,
      url,
    );
    const etag = response.headers.get('etag');
    if (etag) {
      next.etag = etag;
    }
  } else {
    throw new Error(`HTTP ${response.status}`);
  }
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await atomicWriteJSON(cachePath, next);
  invalidateModelCatalog();
  debugLogger.debug(
    `Model catalog refreshed from ${url}: ${Object.keys(next.models).length} models`,
  );
}

let inFlight: Promise<void> | undefined;

/**
 * Best-effort background refresh of the models.dev cache. Never throws and
 * never blocks: callers fire it once the proxy dispatcher is installed and
 * carry on; the bundled snapshot covers every run until the cache lands.
 */
export function refreshModelCatalog(): Promise<void> {
  if (
    isModelCatalogDisabled() ||
    process.env[MODEL_CATALOG_REFRESH_ENV] === 'off'
  ) {
    return Promise.resolve();
  }
  inFlight ??= fetchAndStore()
    .catch((error: unknown) => {
      debugLogger.debug(
        `Model catalog refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}
