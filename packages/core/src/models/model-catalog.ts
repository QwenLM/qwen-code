/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import type { InputModalities } from '../core/contentGenerator.js';
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
    (context === undefined || typeof context === 'number') &&
    (output === undefined || typeof output === 'number') &&
    (modalities === undefined ||
      (typeof modalities === 'object' && modalities !== null))
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

function readCache(): ModelCatalog | undefined {
  try {
    return parseModelCatalog(
      JSON.parse(fs.readFileSync(getModelCatalogCachePath(), 'utf8')),
    );
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
    const cached = readCache();
    loaded = cached && cached.fetchedAt > bundled.fetchedAt ? cached : bundled;
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
  return loadModelCatalog().models[model];
}
