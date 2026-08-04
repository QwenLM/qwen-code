/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { InputModalities } from '../core/contentGenerator.js';
import { Storage } from '../config/storage.js';
import { findProviderByCredentials } from '../providers/all-providers.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { loadUndici, redactProxyError } from '../utils/runtimeFetchOptions.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

const debugLogger = createDebugLogger('MODEL_METADATA_CATALOG');

interface CatalogModel {
  id?: string;
  attachment?: boolean;
  modalities?: {
    input?: string[];
  };
}

interface CatalogProvider {
  api?: string;
  env?: string[];
  models?: Record<string, CatalogModel>;
}

export type ModelMetadataCatalog = Record<string, CatalogProvider>;

type CatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LoadModelMetadataCatalogOptions {
  cachePath?: string;
  proxyUrl?: string;
  fetch?: CatalogFetch;
}

export interface ModelMetadataLookup {
  providerId?: string;
  authType?: string;
  modelId: string;
  baseUrl?: string;
  envKey?: string;
}

let sharedCatalogPromise: Promise<ModelMetadataCatalog> | undefined;

function getCachePath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'models-dev.json');
}

function parseCatalog(text: string): ModelMetadataCatalog | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    for (const provider of Object.values(parsed)) {
      if (
        !provider ||
        typeof provider !== 'object' ||
        Array.isArray(provider)
      ) {
        return undefined;
      }
    }
    return parsed as ModelMetadataCatalog;
  } catch {
    return undefined;
  }
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.ok) {
    throw new Error(`models.dev returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES) {
    throw new Error('models.dev response is too large');
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_CATALOG_BYTES) {
      await reader.cancel();
      throw new Error('models.dev response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchCatalog(
  proxyUrl: string | undefined,
  fetchOverride?: CatalogFetch,
): Promise<{ catalog: ModelMetadataCatalog; text: string }> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let response: Response;
  let closeDispatcher: (() => Promise<void>) | undefined;

  if (fetchOverride) {
    response = await fetchOverride(MODELS_DEV_URL, { signal });
  } else if (proxyUrl) {
    const { EnvHttpProxyAgent, fetch: undiciFetch } = await loadUndici();
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
    });
    closeDispatcher = () => dispatcher.close();
    try {
      response = (await undiciFetch(MODELS_DEV_URL, {
        dispatcher,
        signal,
      })) as unknown as Response;
    } catch (error) {
      await dispatcher.close();
      throw error;
    }
  } else {
    response = await fetch(MODELS_DEV_URL, { signal });
  }

  try {
    const text = await readResponseText(response);
    const catalog = parseCatalog(text);
    if (!catalog || Object.keys(catalog).length === 0) {
      throw new Error('models.dev returned an invalid catalog');
    }
    return { catalog, text };
  } finally {
    await closeDispatcher?.();
  }
}

async function writeCache(cachePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await atomicWriteFile(cachePath, text, { flush: false });
}

async function fetchAndCache(
  cachePath: string,
  options: LoadModelMetadataCatalogOptions,
): Promise<ModelMetadataCatalog> {
  const { catalog, text } = await fetchCatalog(options.proxyUrl, options.fetch);
  try {
    await writeCache(cachePath, text);
  } catch (error) {
    debugLogger.debug(
      'Failed to cache models.dev catalog:',
      redactProxyError(error),
    );
  }
  return catalog;
}

async function loadCatalog(
  options: LoadModelMetadataCatalogOptions,
): Promise<ModelMetadataCatalog> {
  const cachePath = options.cachePath ?? getCachePath();

  try {
    const [text, stat] = await Promise.all([
      fs.readFile(cachePath, 'utf8'),
      fs.stat(cachePath),
    ]);
    const catalog = parseCatalog(text);
    if (catalog && Object.keys(catalog).length > 0) {
      if (Date.now() - stat.mtimeMs >= CACHE_TTL_MS) {
        void fetchAndCache(cachePath, options).catch((error) => {
          debugLogger.debug(
            'Failed to refresh models.dev catalog:',
            redactProxyError(error),
          );
        });
      }
      return catalog;
    }
  } catch (error) {
    debugLogger.debug(
      'Failed to read models.dev cache:',
      redactProxyError(error),
    );
  }

  try {
    return await fetchAndCache(cachePath, options);
  } catch (error) {
    debugLogger.debug(
      'Failed to fetch models.dev catalog:',
      redactProxyError(error),
    );
    return {};
  }
}

/** Load the models.dev catalog with a stale-while-revalidate disk cache. */
export function loadModelMetadataCatalog(
  options: LoadModelMetadataCatalogOptions = {},
): Promise<ModelMetadataCatalog> {
  const useSharedPromise =
    options.cachePath === undefined && options.fetch === undefined;
  if (!useSharedPromise) return loadCatalog(options);

  sharedCatalogPromise ??= loadCatalog(options);
  return sharedCatalogPromise;
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.replace(/\/+$/, '').toLowerCase();
}

function mapProviderId(providerId: string | undefined): string | undefined {
  switch (providerId) {
    case 'coding-plan':
    case 'token-plan':
    case 'alibabaStandard':
    case 'qwen-oauth':
      return 'alibaba';
    case 'grok':
      return 'xai';
    case 'gemini':
    case 'vertex-ai':
      return 'google';
    case 'custom-openai-compatible':
    case 'idealab':
      return undefined;
    default:
      return providerId;
  }
}

function resolveCatalogProviderId(
  catalog: ModelMetadataCatalog,
  lookup: ModelMetadataLookup,
): string | undefined {
  const configuredProvider = findProviderByCredentials(
    lookup.baseUrl,
    lookup.envKey,
  );
  const configuredId = mapProviderId(configuredProvider?.id);
  if (configuredId && catalog[configuredId]) return configuredId;

  const normalizedBaseUrl = normalizeUrl(lookup.baseUrl);
  if (normalizedBaseUrl) {
    const endpointMatch = Object.entries(catalog).find(
      ([, provider]) => normalizeUrl(provider.api) === normalizedBaseUrl,
    );
    if (endpointMatch) return endpointMatch[0];
  }

  const envKey = lookup.envKey;
  if (envKey) {
    const envMatches = Object.entries(catalog).filter(([, provider]) =>
      Array.isArray(provider.env) ? provider.env.includes(envKey) : false,
    );
    if (envMatches.length === 1) return envMatches[0]?.[0];
  }

  for (const candidate of [lookup.providerId, lookup.authType]) {
    const mapped = mapProviderId(candidate);
    if (mapped && catalog[mapped]) return mapped;
  }
  return undefined;
}

function findCatalogModel(
  provider: CatalogProvider,
  modelId: string,
): CatalogModel | undefined {
  const models = provider.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return undefined;
  }
  const exact = models[modelId];
  if (exact && typeof exact === 'object') return exact;

  const normalizedId = modelId.toLowerCase();
  return Object.entries(models).find(
    ([key, model]) =>
      model !== null &&
      typeof model === 'object' &&
      (key.toLowerCase() === normalizedId ||
        (typeof model.id === 'string' &&
          model.id.toLowerCase() === normalizedId)),
  )?.[1];
}

/** Return exact catalog input modalities, or undefined when metadata is absent. */
export function getCatalogModalities(
  catalog: ModelMetadataCatalog | undefined,
  lookup: ModelMetadataLookup,
): InputModalities | undefined {
  if (!catalog || Object.keys(catalog).length === 0) return undefined;
  const providerId = resolveCatalogProviderId(catalog, lookup);
  if (!providerId) return undefined;

  const model = findCatalogModel(catalog[providerId]!, lookup.modelId);
  if (!model) return undefined;

  const input = model.modalities?.input;
  if (!Array.isArray(input)) {
    return model.attachment ? { image: true } : undefined;
  }

  const modalities: InputModalities = {};
  if (input.includes('image')) modalities.image = true;
  if (input.includes('pdf')) modalities.pdf = true;
  if (input.includes('audio')) modalities.audio = true;
  if (input.includes('video')) modalities.video = true;
  return modalities;
}
