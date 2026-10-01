/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import type { InputModalities } from '../core/contentGenerator.js';
import { normalize } from '../core/tokenLimits.js';
import bundledCatalog from './generated/model-registry.json' with { type: 'json' };

export interface ModelCatalogEntry {
  /** Context window: models.dev `limit.input`, else `limit.context`. */
  context?: number;
  /** Maximum output tokens: models.dev `limit.output`. */
  output?: number;
  /** Non-text input modalities the model accepts. */
  modalities?: InputModalities;
}

export interface ModelCatalog {
  source: string;
  fetchedAt: string;
  projection: number;
  etag?: string;
  models: Record<string, ModelCatalogEntry>;
}

// Bump when projection rules change so older caches are fetched and reprojected.
export const MODEL_CATALOG_PROJECTION_VERSION = 1;

/** `QWEN_CODE_MODELS_DEV=off` restores the regex-only model tables. */
export const MODEL_CATALOG_ENV = 'QWEN_CODE_MODELS_DEV';
export const MODELS_DEV_URL = 'https://models.dev/api.json';
/** Replaces the models.dev URL, e.g. with a corporate mirror. */
export const MODEL_CATALOG_URL_ENV = 'QWEN_CODE_MODELS_DEV_URL';

const GENERIC_MODEL_KEYS = new Set([
  'auto',
  'fast',
  'free',
  'latest',
  'low',
  'max',
]);

export function isModelCatalogDisabled(): boolean {
  return process.env[MODEL_CATALOG_ENV] === 'off';
}

export function isModelCatalogKey(key: string): boolean {
  return (
    normalize(key) === key &&
    !/^\d+$/.test(key) &&
    !key.includes('@') &&
    !GENERIC_MODEL_KEYS.has(key) &&
    (key.length >= 5 || /^o\d+$/i.test(key))
  );
}

export function getModelCatalogCachePath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'model-registry.json');
}

/**
 * Modality keys the catalog understands. This is the single list: the
 * refresh projection writes exactly these (`toModalities`), so a new
 * `InputModalities` key fails tsc here at declaration time rather than
 * silently discarding entries at parse time.
 */
export const CATALOG_MODALITIES: ReadonlyArray<keyof InputModalities> = [
  'image',
  'pdf',
  'audio',
  'video',
];

/**
 * Narrows a raw object key to one the catalog understands. Widening to
 * `readonly string[]` is what lets `includes` accept an arbitrary key, but it
 * also stops the result from narrowing — hence the predicate.
 */
function isCatalogModality(key: string): key is keyof InputModalities {
  return (CATALOG_MODALITIES as readonly string[]).includes(key);
}

/**
 * Keeps the fields that are valid instead of discarding the entry for one
 * that is not: an unrecognised modality key (e.g. written by a newer build
 * that knows more modalities) degrades that one field rather than taking the
 * model's context window and output limit down with it. Context/output stay
 * strict — a corrupt limit is worse than no limit.
 */
function sanitizeEntry(value: unknown): ModelCatalogEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const { context, output, modalities } = value as ModelCatalogEntry;
  if (
    (context !== undefined &&
      !(Number.isSafeInteger(context) && context > 0)) ||
    (output !== undefined && !(Number.isSafeInteger(output) && output > 0))
  ) {
    return undefined;
  }
  const entry: ModelCatalogEntry = {
    ...(context !== undefined ? { context } : {}),
    ...(output !== undefined ? { output } : {}),
  };
  if (modalities !== undefined) {
    if (
      typeof modalities !== 'object' ||
      modalities === null ||
      Array.isArray(modalities)
    ) {
      return undefined;
    }
    const clean: InputModalities = {};
    for (const [key, flag] of Object.entries(modalities)) {
      if (isCatalogModality(key) && flag === true) {
        clean[key] = true;
      }
    }
    entry.modalities = clean;
  }
  return entry;
}

export function parseModelCatalog(raw: unknown): ModelCatalog | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const { source, fetchedAt, projection, etag, models } =
    raw as Partial<ModelCatalog>;
  if (typeof fetchedAt !== 'string' || !models || typeof models !== 'object') {
    return undefined;
  }
  const valid: Record<string, ModelCatalogEntry> = {};
  for (const [id, entry] of Object.entries(models)) {
    // '__proto__' would invoke the prototype setter instead of creating an
    // own property — the refresh path can legitimately write that key
    // (Object.fromEntries uses [[DefineOwnProperty]]), so tolerate it here.
    if (id === '__proto__') {
      continue;
    }
    const sanitized = sanitizeEntry(entry);
    if (sanitized) {
      valid[id] = sanitized;
    }
  }
  return {
    source: typeof source === 'string' ? source : '',
    fetchedAt,
    projection:
      typeof projection === 'number' && Number.isSafeInteger(projection)
        ? projection
        : 0,
    ...(typeof etag === 'string' ? { etag } : {}),
    models: valid,
  };
}

let loaded: ModelCatalog | undefined;
function readCache(cachePath: string): ModelCatalog | undefined {
  try {
    return parseModelCatalog(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Client-owned context windows. models.dev's `limit.input` is the source of
 * truth for input limits, but for these ids it is bucketed above the window
 * the curated table in `tokenLimits.ts` *and* the provider presets declare,
 * so the declared window wins. Only ids the resolved catalog actually
 * carries are corrected.
 */
const CATALOG_CONTEXT_CORRECTIONS: Readonly<Record<string, number>> = {
  // Sonnet 4.5's retired 1M beta must not override the default API limit.
  // https://platform.claude.com/docs/en/build-with-claude/context-windows
  'claude-sonnet-4-5': 200_000,
  // models.dev rounds the vendor-declared window of these ids up to the next
  // binary size: 1,048,576 for the 1M ids, 204,800 for the MiniMax-M2.5 and
  // GLM-4.7 rounds. The over-stated window is larger than anything the
  // curated row or the presets declare, so compaction thresholds computed
  // from it fire too late and the request 400s at the vendor.
  'qwen3-coder-plus': 1_000_000,
  'kimi-k3': 1_000_000,
  'minimax-m2.5': 196_608,
  'minimax-m2.5-highspeed': 196_608,
  'glm-4.7': 202_752,
};

/**
 * The refreshed cache wins only when it is newer than the snapshot bundled
 * with this build, so upgrading the CLI never serves stale cached data.
 */
export function loadModelCatalog(): ModelCatalog {
  if (!loaded) {
    const bundled = bundledCatalog as ModelCatalog;
    const cached = readCache(getModelCatalogCachePath());
    const source = process.env[MODEL_CATALOG_URL_ENV] || MODELS_DEV_URL;
    // A cache written before the projection's guards can hold keys no
    // normalized spelling reaches (deepseek-v3 did) or no usable entries at
    // all; neither may displace the bundled snapshot.
    const usableEntries = Object.entries(cached?.models ?? {}).filter(([key]) =>
      isModelCatalogKey(key),
    );
    const usable =
      cached &&
      cached.projection === MODEL_CATALOG_PROJECTION_VERSION &&
      cached.source === source &&
      usableEntries.length > 0
        ? { ...cached, models: Object.fromEntries(usableEntries) }
        : undefined;
    let base =
      usable && usable.fetchedAt > bundled.fetchedAt ? usable : bundled;
    const models = { ...base.models };
    let corrected = false;
    for (const [id, context] of Object.entries(CATALOG_CONTEXT_CORRECTIONS)) {
      const entry = models[id];
      if (entry) {
        models[id] = { ...entry, context };
        corrected = true;
      }
    }
    if (corrected) {
      base = { ...base, models };
    }
    loaded = base;
  }
  return loaded;
}

export function invalidateModelCatalog(): void {
  loaded = undefined;
}

/**
 * `model` must already be normalized (`normalize()` in tokenLimits.ts) so
 * the catalog keys and the regex tables see the same id.
 */
export function lookupModelCatalog(
  model: string,
): ModelCatalogEntry | undefined {
  if (isModelCatalogDisabled()) {
    return undefined;
  }
  const entry = loadModelCatalog().models[model];
  // DashScope PDF support depends on endpoint and protocol (not Responses).
  // Keep it opt-in through explicit model configuration until scoped lookup.
  if (model === 'qwen3.8-max' && entry?.modalities?.pdf) {
    const modalities = { ...entry.modalities };
    delete modalities.pdf;
    return { ...entry, modalities };
  }
  return entry;
}
