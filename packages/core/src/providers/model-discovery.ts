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
// a comma, control byte, or invisible format character would split into bogus
// models or poison the TUI.
const UNSAFE_MODEL_ID_CHARS =
  // eslint-disable-next-line no-control-regex -- control bytes are exactly what this rejects
  /[,\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

interface DiscoverProviderModelsOptions {
  baseUrl: string;
  apiKey: string;
  staticModels: readonly ModelSpec[];
  signal?: AbortSignal;
}

function readModelIds(value: unknown): string[] | null {
  if (!value || typeof value !== 'object' || !('data' in value)) {
    return null;
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return null;
  }

  const ids: string[] = [];
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
      ids.push(trimmedId);
    }
  }
  return ids.length > 0 ? ids : null;
}

function mergeModelSpecs(
  ids: string[],
  staticModels: readonly ModelSpec[],
): ModelSpec[] {
  const discoveredIds = new Set(ids);
  const knownModels = staticModels.filter((model) =>
    discoveredIds.has(model.id),
  );
  const knownIds = new Set(knownModels.map((model) => model.id));
  return [
    ...knownModels,
    ...ids.filter((id) => !knownIds.has(id)).map((id) => ({ id })),
  ];
}

export async function discoverProviderModels({
  baseUrl,
  apiKey,
  staticModels,
  signal,
}: DiscoverProviderModelsOptions): Promise<ModelSpec[] | null> {
  const normalizedBaseUrl = baseUrl.trim();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedBaseUrl || !normalizedApiKey) {
    return null;
  }

  try {
    const modelsUrl = `${normalizedBaseUrl.replace(/\/+$/, '')}/models`;
    const result = await fetchWithPolicy(modelsUrl, {
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      maxBytes: DISCOVERY_MAX_BYTES,
      maxRedirects: 2,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${normalizedApiKey}`,
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

    const ids = readModelIds(JSON.parse(result.body.toString('utf8')));
    return ids ? mergeModelSpecs(ids, staticModels) : null;
  } catch {
    return null;
  }
}
