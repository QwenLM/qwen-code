/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
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
/** `QWEN_CODE_MODELS_DEV_REFRESH=off` keeps the bundled snapshot and never fetches models.dev. */
export const MODEL_CATALOG_REFRESH_ENV = 'QWEN_CODE_MODELS_DEV_REFRESH';
/** Replaces the models.dev URL, e.g. with a corporate mirror. */
export const MODEL_CATALOG_URL_ENV = 'QWEN_CODE_MODELS_DEV_URL';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * models.dev providers whose entries feed the catalog. Conflicting normalized
 * ids are omitted so endpoint-specific limits fall back to existing tables.
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
  tool_call?: boolean;
  limit?: { context?: number; input?: number; output?: number };
  modalities?: { input?: string[]; output?: string[] };
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
  if (context !== undefined && Number.isSafeInteger(context) && context > 0) {
    entry.context = context;
  }
  if (
    model.limit?.output !== undefined &&
    Number.isSafeInteger(model.limit.output) &&
    model.limit.output > 0
  ) {
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
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/**
 * Only models that can drive the agent loop are worth recording: they must
 * accept tool calls and answer in text. models.dev also lists embedding,
 * text-to-speech, image and video models whose limits mean something else
 * entirely — `gemini-embedding-001` reports an output limit of 1 and
 * `veo-3.1-generate` a context of 480 — and those numbers would then outrank
 * the family fallbacks that keep such ids harmless today.
 */
function servesAgentTurns(model: ModelsDevModel): boolean {
  return (
    model.tool_call === true &&
    (model.modalities?.output ?? []).includes('text')
  );
}

/** `toEntry` builds its keys in a fixed order, so this compares by value. */
function sameEntry(a: ModelCatalogEntry, b: ModelCatalogEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Projects a models.dev `api.json` payload onto the catalog shape: one entry
 * per normalized model id with only the fields the limit and modality tables
 * consume.
 *
 * Two ids can land on the same key, either because they normalize together
 * (`qwen3-max` and `qwen3-max-20260123`) or because several providers serve
 * the same model. If any of these entries disagree, the key is
 * dropped rather than guessed: a context window or output limit is a property
 * of the endpoint, not of the weights, and the catalog cannot tell which
 * endpoint a request will reach. DashScope caps GLM-5 output at 16,384 while
 * Z.ai allows 131,072, and both numbers are correct for their own endpoint.
 * Recording either one would be wrong for half of the users, so such models
 * keep the answer the regex tables give them today.
 */
export function trimModelsDevCatalog(
  api: ModelsDevApi,
  fetchedAt: string,
  source: string = MODELS_DEV_URL,
): ModelCatalog {
  const candidates = new Map<string, ModelCatalogEntry[]>();
  for (const provider of MODELS_DEV_PROVIDERS) {
    for (const model of Object.values(api[provider]?.models ?? {})) {
      if (typeof model.id !== 'string' || !servesAgentTurns(model)) {
        continue;
      }
      const entry = toEntry(model);
      if (!entry) {
        continue;
      }
      const key = normalize(model.id);
      const existing = candidates.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        candidates.set(key, [entry]);
      }
    }
  }
  const agreed: Array<readonly [string, ModelCatalogEntry]> = [];
  for (const [key, all] of candidates) {
    const first = all[0]!;
    if (all.every((entry) => sameEntry(entry, first))) {
      agreed.push([key, first]);
    }
  }
  return { source, fetchedAt, models: sortedModels(agreed) };
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

async function refreshRemote(url: string, cachePath: string): Promise<void> {
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
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await atomicWriteJSON(cachePath, next);
  invalidateModelCatalog();
  debugLogger.debug(
    `Model catalog refreshed from ${url}: ${Object.keys(next.models).length} models`,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let inFlight: Promise<void> | undefined;

/**
 * Best-effort background refresh. Call after installing the proxy dispatcher;
 * the bundled snapshot covers startup while the request is in flight.
 */
export function refreshModelCatalog(): Promise<void> {
  if (
    isModelCatalogDisabled() ||
    process.env[MODEL_CATALOG_REFRESH_ENV] === 'off'
  ) {
    return Promise.resolve();
  }
  const url = process.env[MODEL_CATALOG_URL_ENV] || MODELS_DEV_URL;
  inFlight ??= refreshRemote(url, getModelCatalogCachePath())
    .catch((error: unknown) => {
      debugLogger.debug(`Model catalog refresh skipped: ${describe(error)}`);
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}
