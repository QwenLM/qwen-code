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
import builtInModelModalities from './generated/models-dev-modalities.json' with { type: 'json' };

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const OPENROUTER_VARIANT_SUFFIX =
  /:(?:free|extended|thinking|online|nitro|floor|exacto)$/i;

const debugLogger = createDebugLogger('MODEL_METADATA_CATALOG');

interface CatalogModelMetadata {
  id?: string;
  attachment?: boolean;
  modalities?: {
    input?: string[];
  };
}

type CatalogModel = CatalogModelMetadata | string[];

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

export type ModelModalitiesSource =
  | 'explicit'
  | 'catalog'
  | 'heuristic';

interface CatalogState {
  current?: ModelMetadataCatalog;
  loading?: Promise<ModelMetadataCatalog>;
  refresh?: Promise<void>;
  refreshTimer?: ReturnType<typeof setTimeout>;
}

const builtInCatalog = builtInModelModalities as ModelMetadataCatalog;
const catalogStates = new Map<string, CatalogState>();

function getCachePath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'models-dev.json');
}

function parseCatalog(text: string): ModelMetadataCatalog | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    let modelCount = 0;
    for (const provider of Object.values(parsed)) {
      if (
        !provider ||
        typeof provider !== 'object' ||
        Array.isArray(provider)
      ) {
        return undefined;
      }
      const { api, env, models } = provider as CatalogProvider;
      if (api !== undefined && typeof api !== 'string') return undefined;
      if (
        env !== undefined &&
        (!Array.isArray(env) || env.some((key) => typeof key !== 'string'))
      ) {
        return undefined;
      }
      if (!models || typeof models !== 'object' || Array.isArray(models)) {
        return undefined;
      }
      if (Object.keys(models).length === 0) return undefined;
      for (const model of Object.values(models)) {
        if (Array.isArray(model)) {
          if (model.some((modality) => typeof modality !== 'string')) {
            return undefined;
          }
        } else {
          if (!model || typeof model !== 'object') return undefined;
          const input = model.modalities?.input;
          if (
            !Array.isArray(input) ||
            input.some((modality) => typeof modality !== 'string')
          ) {
            return undefined;
          }
        }
        modelCount += 1;
      }
    }
    return modelCount > 0 ? (parsed as ModelMetadataCatalog) : undefined;
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

function scheduleRefresh(
  state: CatalogState,
  cachePath: string,
  options: LoadModelMetadataCatalogOptions,
  delayMs: number,
): void {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = undefined;
    refreshCatalog(state, cachePath, options, true);
  }, delayMs);
  state.refreshTimer.unref();
}

function refreshCatalog(
  state: CatalogState,
  cachePath: string,
  options: LoadModelMetadataCatalogOptions,
  keepFresh: boolean,
): void {
  if (state.refresh) return;

  state.refresh = fetchAndCache(cachePath, options)
    .then((catalog) => {
      state.current = catalog;
    })
    .catch((error) => {
      debugLogger.debug(
        'Failed to refresh models.dev catalog:',
        redactProxyError(error),
      );
    })
    .finally(() => {
      state.refresh = undefined;
      if (keepFresh) {
        scheduleRefresh(state, cachePath, options, CACHE_TTL_MS);
      }
    });
}

async function loadInitialCatalog(
  state: CatalogState,
  cachePath: string,
  options: LoadModelMetadataCatalogOptions,
): Promise<ModelMetadataCatalog> {
  const keepFresh =
    options.cachePath === undefined && options.fetch === undefined;

  try {
    const [text, stat] = await Promise.all([
      fs.readFile(cachePath, 'utf8'),
      fs.stat(cachePath),
    ]);
    const catalog = parseCatalog(text);
    if (catalog && Object.keys(catalog).length > 0) {
      state.current = catalog;
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs >= CACHE_TTL_MS) {
        refreshCatalog(state, cachePath, options, keepFresh);
      } else if (keepFresh) {
        scheduleRefresh(state, cachePath, options, CACHE_TTL_MS - ageMs);
      }
      return catalog;
    }
  } catch (error) {
    debugLogger.debug(
      'Failed to read models.dev cache:',
      redactProxyError(error),
    );
  }

  state.current = builtInCatalog;
  refreshCatalog(state, cachePath, options, keepFresh);
  return builtInCatalog;
}

/** Load model modalities immediately and refresh models.dev in the background. */
export function loadModelMetadataCatalog(
  options: LoadModelMetadataCatalogOptions = {},
): Promise<ModelMetadataCatalog> {
  const cachePath = path.resolve(options.cachePath ?? getCachePath());
  let state = catalogStates.get(cachePath);
  if (!state) {
    state = {};
    catalogStates.set(cachePath, state);
  }

  if (state.current) return Promise.resolve(state.current);

  state.loading ??= loadInitialCatalog(state, cachePath, options);
  return state.loading;
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return value.replace(/\/+$/, '').toLowerCase();
}

function mapProviderId(
  providerId: string | undefined,
  hasBaseUrl = false,
): string | undefined {
  switch (providerId) {
    case 'coding-plan':
      return hasBaseUrl ? undefined : 'alibaba-coding-plan-cn';
    case 'token-plan':
      return hasBaseUrl ? undefined : 'alibaba-token-plan-cn';
    case 'alibabaStandard':
      return hasBaseUrl ? undefined : 'alibaba-cn';
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

function mapModelFamilyProvider(modelId: string): string | undefined {
  if (/^deepseek(?:[-./]|$)/i.test(modelId)) return 'deepseek';
  if (/^kimi(?:[-./]|$)/i.test(modelId)) return 'moonshotai';
  if (/^minimax(?:[-./]|$)/i.test(modelId)) return 'minimax';
  if (/^glm(?:[-./]|$)/i.test(modelId)) return 'zai';
  return undefined;
}

function mapIdealabProvider(modelId: string): string | undefined {
  if (/^qwen.*-dogfooding$/i.test(modelId)) return 'alibaba-cn';
  const bailianModelId = modelId.match(/^bailian\/(.+)$/i)?.[1];
  if (!bailianModelId) return undefined;
  if (/^qwen(?:\d|[-.]|$)/i.test(bailianModelId)) return 'alibaba-cn';
  return mapModelFamilyProvider(bailianModelId);
}

function findOriginalProviderModel(
  catalog: ModelMetadataCatalog,
  currentProviderId: string,
  modelId: string,
  sourceProviderId: string | undefined,
): CatalogModel | undefined {
  const providerId = mapModelFamilyProvider(modelId);
  if (providerId === currentProviderId) return undefined;
  const provider = providerId ? catalog[providerId] : undefined;
  if (!provider || !providerId) return undefined;
  return findCatalogModel(provider, providerId, sourceProviderId, modelId);
}

function resolveCatalogProviderId(
  catalog: ModelMetadataCatalog,
  lookup: ModelMetadataLookup,
): string | undefined {
  const normalizedBaseUrl = normalizeUrl(lookup.baseUrl);
  if (normalizedBaseUrl) {
    const endpointMatch = Object.entries(catalog).find(
      ([, provider]) => normalizeUrl(provider.api) === normalizedBaseUrl,
    );
    if (endpointMatch) return endpointMatch[0];
  }

  const configuredProvider = findProviderByCredentials(
    lookup.baseUrl,
    lookup.envKey,
  );
  const sourceProviderId = configuredProvider?.id ?? lookup.providerId;
  if (sourceProviderId === 'idealab') {
    const idealabProviderId = mapIdealabProvider(lookup.modelId);
    if (idealabProviderId && catalog[idealabProviderId]) {
      return idealabProviderId;
    }
  }
  const configuredId = mapProviderId(
    configuredProvider?.id,
    normalizedBaseUrl !== undefined,
  );
  if (configuredId && catalog[configuredId]) return configuredId;

  const envKey = lookup.envKey;
  if (envKey) {
    const envMatches = Object.entries(catalog).filter(([, provider]) =>
      Array.isArray(provider.env) ? provider.env.includes(envKey) : false,
    );
    if (envMatches.length === 1) return envMatches[0]?.[0];
  }

  const hasProviderEvidence =
    normalizedBaseUrl !== undefined || lookup.envKey !== undefined;
  for (const candidate of [lookup.providerId, lookup.authType]) {
    const mapped = mapProviderId(candidate, normalizedBaseUrl !== undefined);
    const isProtocolFallback = candidate === lookup.authType;
    if (
      mapped &&
      catalog[mapped] &&
      (!hasProviderEvidence || !isProtocolFallback)
    ) {
      return mapped;
    }
  }
  return undefined;
}

function findCatalogModel(
  provider: CatalogProvider,
  catalogProviderId: string,
  sourceProviderId: string | undefined,
  modelId: string,
): CatalogModel | undefined {
  const models = provider.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return undefined;
  }
  const candidates = [modelId];
  if (catalogProviderId === 'openrouter') {
    const baseModelId = modelId.replace(OPENROUTER_VARIANT_SUFFIX, '');
    if (baseModelId !== modelId) candidates.push(baseModelId);
  }
  if (sourceProviderId === 'idealab') {
    if (/^qwen.*-dogfooding$/i.test(modelId)) {
      candidates.push(modelId.replace(/-dogfooding$/i, ''));
    } else if (/^bailian\//i.test(modelId)) {
      candidates.push(modelId.replace(/^bailian\//i, ''));
    }
  }

  for (const candidate of candidates) {
    const exact = models[candidate];
    if (exact && typeof exact === 'object') return exact;

    const normalizedId = candidate.toLowerCase();
    const caseInsensitive = Object.entries(models).find(
      ([key, model]) =>
        model !== null &&
        typeof model === 'object' &&
        (key.toLowerCase() === normalizedId ||
          (!Array.isArray(model) &&
            typeof model.id === 'string' &&
            model.id.toLowerCase() === normalizedId)),
    )?.[1];
    if (caseInsensitive) return caseInsensitive;
  }
  return undefined;
}

/** Return exact catalog input modalities, or undefined when metadata is absent. */
export function getCatalogModalities(
  catalog: ModelMetadataCatalog | undefined,
  lookup: ModelMetadataLookup,
): InputModalities | undefined {
  if (!catalog || Object.keys(catalog).length === 0) return undefined;
  const providerId = resolveCatalogProviderId(catalog, lookup);
  if (!providerId) return undefined;

  const sourceProviderId =
    findProviderByCredentials(lookup.baseUrl, lookup.envKey)?.id ??
    lookup.providerId;

  const providerModel = findCatalogModel(
    catalog[providerId]!,
    providerId,
    sourceProviderId,
    lookup.modelId,
  );
  const model =
    providerModel ??
    findOriginalProviderModel(
      catalog,
      providerId,
      lookup.modelId,
      sourceProviderId,
    );
  if (!model) return undefined;

  const input = Array.isArray(model) ? model : model.modalities?.input;
  if (!Array.isArray(input)) {
    return !Array.isArray(model) && model.attachment
      ? { image: true }
      : undefined;
  }

  const modalities: InputModalities = {};
  if (input.includes('image')) modalities.image = true;
  if (input.includes('pdf')) modalities.pdf = true;
  if (input.includes('audio')) modalities.audio = true;
  if (input.includes('video')) modalities.video = true;
  return modalities;
}
