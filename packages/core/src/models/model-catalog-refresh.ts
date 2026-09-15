/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InputModalities } from '../core/contentGenerator.js';
import { normalize } from '../core/tokenLimits.js';
import {
  atomicWriteFileSync,
  atomicWriteJSON,
} from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  getCustomModelCatalogCachePath,
  getModelCatalogCachePath,
  invalidateModelCatalog,
  isModelCatalogDisabled,
  parseModelCatalog,
  setCustomModelCatalogSource,
  type ModelCatalog,
  type ModelCatalogEntry,
} from './model-catalog.js';

const debugLogger = createDebugLogger('MODEL_CATALOG');

export const MODELS_DEV_URL = 'https://models.dev/api.json';
/** `QWEN_CODE_MODELS_DEV_REFRESH=off` keeps the bundled snapshot and never fetches models.dev. */
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

function sortedModels(
  entries: Iterable<readonly [string, ModelCatalogEntry]>,
): Record<string, ModelCatalogEntry> {
  const models: Record<string, ModelCatalogEntry> = {};
  for (const [key, entry] of [...entries].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    models[key] = entry;
  }
  return models;
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
  providers: readonly string[] = MODELS_DEV_PROVIDERS,
): ModelCatalog {
  const picked = new Map<
    string,
    { exact: boolean; releaseDate: string; entry: ModelCatalogEntry }
  >();
  for (const provider of providers) {
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
  return {
    source,
    fetchedAt,
    models: sortedModels(
      [...picked].map(([key, { entry }]) => [key, entry] as const),
    ),
  };
}

/**
 * Projects a `model.customCatalog` document: either the trimmed shape
 * (`{ models: { id: entry } }`, ids normalized here) or a models.dev-style
 * payload, from which every provider present is read since the file is the
 * user's own selection.
 */
export function projectCustomCatalog(
  raw: unknown,
  fetchedAt: string,
  source: string,
): ModelCatalog {
  const models = (raw as { models?: unknown } | null)?.models;
  if (models && typeof models === 'object') {
    const parsed = parseModelCatalog({ fetchedAt, models });
    return {
      source,
      fetchedAt,
      models: sortedModels(
        Object.entries(parsed?.models ?? {}).map(
          ([id, entry]) => [normalize(id), entry] as const,
        ),
      ),
    };
  }
  const api = (raw ?? {}) as ModelsDevApi;
  return trimModelsDevCatalog(api, fetchedAt, source, Object.keys(api));
}

async function readCacheFile(
  cachePath: string,
): Promise<ModelCatalog | undefined> {
  try {
    return parseModelCatalog(
      JSON.parse(await fs.promises.readFile(cachePath, 'utf8')),
    );
  } catch {
    return undefined;
  }
}

async function refreshRemote(
  url: string,
  cachePath: string,
  project: (raw: unknown, fetchedAt: string) => ModelCatalog,
): Promise<void> {
  const cached = await readCacheFile(cachePath);
  const reusable = cached?.source === url ? cached : undefined;
  if (
    reusable &&
    Date.now() - Date.parse(reusable.fetchedAt) < REFRESH_INTERVAL_MS
  ) {
    return;
  }
  const headers: Record<string, string> = {};
  if (reusable?.etag) {
    headers['If-None-Match'] = reusable.etag;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const fetchedAt = new Date().toISOString();
  let next: ModelCatalog;
  if (response.status === 304 && reusable) {
    next = { ...reusable, fetchedAt };
  } else if (response.ok) {
    next = project(await response.json(), fetchedAt);
    const etag = response.headers.get('etag');
    if (etag) {
      next.etag = etag;
    }
  } else {
    throw new Error(`HTTP ${response.status}`);
  }
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await atomicWriteJSON(cachePath, next);
  invalidateModelCatalog();
  debugLogger.debug(
    `Model catalog refreshed from ${url}: ${Object.keys(next.models).length} models`,
  );
}

/**
 * A custom catalog given as a file is re-read synchronously on every start
 * so the first model resolution of the session already sees it — offline
 * users have nothing else to fall back on.
 */
function materializeLocalCatalog(source: string): void {
  const cachePath = getCustomModelCatalogCachePath();
  const catalog = projectCustomCatalog(
    JSON.parse(fs.readFileSync(source, 'utf8')),
    new Date().toISOString(),
    source,
  );
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  atomicWriteFileSync(cachePath, JSON.stringify(catalog, null, 2));
  invalidateModelCatalog();
}

function isUrl(source: string): boolean {
  return /^https?:\/\//.test(source);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let inFlight: Promise<void> | undefined;

/**
 * Best-effort background refresh of the models.dev cache and, when
 * configured, the custom catalog. Never throws and never blocks: callers
 * fire it once the proxy dispatcher is installed and carry on; the bundled
 * snapshot covers every run until the caches land.
 */
export function refreshModelCatalog(customSource?: string): Promise<void> {
  setCustomModelCatalogSource(customSource);
  if (isModelCatalogDisabled()) {
    return Promise.resolve();
  }
  if (customSource && !isUrl(customSource)) {
    try {
      materializeLocalCatalog(customSource);
    } catch (error) {
      debugLogger.debug(
        `Custom model catalog ${customSource} skipped: ${describe(error)}`,
      );
    }
  }
  inFlight ??= (async () => {
    if (process.env[MODEL_CATALOG_REFRESH_ENV] !== 'off') {
      const url = process.env[MODEL_CATALOG_URL_ENV] || MODELS_DEV_URL;
      await refreshRemote(url, getModelCatalogCachePath(), (raw, fetchedAt) =>
        trimModelsDevCatalog(raw as ModelsDevApi, fetchedAt, url),
      ).catch((error: unknown) => {
        debugLogger.debug(`Model catalog refresh skipped: ${describe(error)}`);
      });
    }
    if (customSource && isUrl(customSource)) {
      await refreshRemote(
        customSource,
        getCustomModelCatalogCachePath(),
        (raw, fetchedAt) => projectCustomCatalog(raw, fetchedAt, customSource),
      ).catch((error: unknown) => {
        debugLogger.debug(
          `Custom model catalog refresh skipped: ${describe(error)}`,
        );
      });
    }
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
