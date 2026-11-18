/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchWithPolicy } from '../utils/fetch.js';
import type { ModelSpec } from './types.js';

const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_BYTES = 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 256;
// The wizard joins ids with commas and renders them raw, so a served id with
// a comma or a code point in the Unicode C (other) category would split into
// bogus models or poison the TUI.
const UNSAFE_MODEL_ID_CHARS = /[,\p{C}\p{Zl}\p{Zp}]/u;

interface DiscoverProviderModelsOptions {
  baseUrl: string;
  apiKey: string;
  staticModels: readonly ModelSpec[];
  signal?: AbortSignal;
  protocol?: 'openai' | 'openai-responses' | 'anthropic';
  maxRedirects?: number;
}

interface DiscoveredModel {
  id: string;
  created?: number;
}

function readModels(value: unknown): DiscoveredModel[] | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const listing = value as { data?: unknown; models?: unknown };
  const data =
    listing.data ??
    (listing.models &&
    typeof listing.models === 'object' &&
    !Array.isArray(listing.models)
      ? Object.entries(listing.models)
          .filter(
            ([, model]) =>
              model !== null &&
              typeof model === 'object' &&
              !Array.isArray(model),
          )
          .map(([id]) => ({ id }))
      : undefined);
  if (!Array.isArray(data)) {
    return null;
  }

  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object' || !('id' in item)) {
      return null;
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string') {
      return null;
    }
    const trimmedId = id.trim();
    if (
      trimmedId &&
      trimmedId.length <= MAX_MODEL_ID_LENGTH &&
      !UNSAFE_MODEL_ID_CHARS.test(trimmedId) &&
      !seen.has(trimmedId)
    ) {
      seen.add(trimmedId);
      const created = (item as { created?: unknown }).created;
      const creationTime =
        typeof created === 'number' && Number.isFinite(created) && created >= 0
          ? created
          : undefined;
      models.push({
        id: trimmedId,
        ...(creationTime === undefined ? {} : { created: creationTime }),
      });
    }
  }
  return models.length > 0 ? models : null;
}

function mergeModelSpecs(
  discoveredModels: DiscoveredModel[],
  staticModels: readonly ModelSpec[],
): ModelSpec[] {
  const staticModelsById = new Map(
    staticModels.map((model) => [model.id, model]),
  );
  const orderedModels = [...discoveredModels];
  if (orderedModels.every((model) => model.created !== undefined)) {
    orderedModels.sort(
      (left, right) => (right.created ?? 0) - (left.created ?? 0),
    );
  }
  return orderedModels.map(({ id }) => staticModelsById.get(id) ?? { id });
}

export async function discoverProviderModels({
  baseUrl,
  apiKey,
  staticModels,
  signal,
  protocol = 'openai',
  maxRedirects = 2,
}: DiscoverProviderModelsOptions): Promise<ModelSpec[] | null> {
  const normalizedBaseUrl = baseUrl.trim();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedBaseUrl || !normalizedApiKey) {
    return null;
  }

  try {
    let base = normalizedBaseUrl.replace(/\/+$/, '');
    if (protocol !== 'openai') base = base.replace(/\/v1$/, '') + '/v1';
    const modelsUrl = `${base}/models${protocol === 'anthropic' ? '?limit=1000' : ''}`;
    const result = await fetchWithPolicy(modelsUrl, {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      maxBytes: DISCOVERY_MAX_BYTES,
      maxRedirects,
      headers: {
        Accept: 'application/json',
        ...(protocol === 'anthropic'
          ? { 'x-api-key': normalizedApiKey, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${normalizedApiKey}` }),
      },
      signal,
    });
    if (
      result.kind !== 'response' ||
      result.status < 200 ||
      result.status >= 300
    ) {
      return null;
    }

    const models = readModels(JSON.parse(result.body.toString('utf8')));
    return models ? mergeModelSpecs(models, staticModels) : null;
  } catch {
    return null;
  }
}
