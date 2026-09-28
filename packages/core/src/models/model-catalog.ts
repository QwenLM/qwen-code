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
  etag?: string;
  models: Record<string, ModelCatalogEntry>;
}

/** `QWEN_CODE_MODELS_DEV=off` restores the regex-only model tables. */
export const MODEL_CATALOG_ENV = 'QWEN_CODE_MODELS_DEV';
export const MODELS_DEV_URL = 'https://models.dev/api.json';
/** Replaces the models.dev URL, e.g. with a corporate mirror. */
export const MODEL_CATALOG_URL_ENV = 'QWEN_CODE_MODELS_DEV_URL';

export function isModelCatalogDisabled(): boolean {
  return process.env[MODEL_CATALOG_ENV] === 'off';
}

export function getModelCatalogCachePath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'model-registry.json');
}

function isEntry(value: unknown): value is ModelCatalogEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const { context, output, modalities } = value as ModelCatalogEntry;
  return (
    (context === undefined || (Number.isSafeInteger(context) && context > 0)) &&
    (output === undefined || (Number.isSafeInteger(output) && output > 0)) &&
    (modalities === undefined ||
      (typeof modalities === 'object' &&
        modalities !== null &&
        !Array.isArray(modalities) &&
        Object.entries(modalities).every(
          ([key, value]) =>
            ['image', 'pdf', 'audio', 'video'].includes(key) && value === true,
        )))
  );
}

export function parseModelCatalog(raw: unknown): ModelCatalog | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const { source, fetchedAt, etag, models } = raw as Partial<ModelCatalog>;
  if (typeof fetchedAt !== 'string' || !models || typeof models !== 'object') {
    return undefined;
  }
  const valid: Record<string, ModelCatalogEntry> = {};
  for (const [id, entry] of Object.entries(models)) {
    if (isEntry(entry)) {
      valid[id] = entry;
    }
  }
  return {
    source: typeof source === 'string' ? source : '',
    fetchedAt,
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
    const usableEntries = Object.entries(cached?.models ?? {}).filter(
      ([key]) => normalize(key) === key,
    );
    const usable =
      cached && cached.source === source && usableEntries.length > 0
        ? { ...cached, models: Object.fromEntries(usableEntries) }
        : undefined;
    let base =
      usable && usable.fetchedAt > bundled.fetchedAt ? usable : bundled;
    // Sonnet 4.5's retired 1M beta must not override the default API limit.
    // https://platform.claude.com/docs/en/build-with-claude/context-windows
    if (base.models['claude-sonnet-4-5']) {
      base = {
        ...base,
        models: {
          ...base.models,
          'claude-sonnet-4-5': {
            ...base.models['claude-sonnet-4-5'],
            context: 200_000,
          },
        },
      };
    }
    // models.dev's alibaba buckets approximate the vendor-declared 1M window
    // of qwen3-coder-plus as 1,048,576; keep the declared 1,000,000.
    if (base.models['qwen3-coder-plus']) {
      base = {
        ...base,
        models: {
          ...base.models,
          'qwen3-coder-plus': {
            ...base.models['qwen3-coder-plus'],
            context: 1_000_000,
          },
        },
      };
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
