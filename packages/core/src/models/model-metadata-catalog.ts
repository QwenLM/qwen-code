/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { AuthType, InputModalities } from '../core/contentGenerator.js';
import { Storage } from '../config/storage.js';
import { findProviderByCredentials } from '../providers/all-providers.js';
import { getDefaultBaseUrlForProtocol } from '../providers/provider-config.js';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeProxyUrl } from '../utils/proxyUtils.js';
import {
  isTlsVerificationDisabled,
  loadUndici,
  redactProxyError,
} from '../utils/runtimeFetchOptions.js';
import builtInModelModalities from './generated/models-dev-modalities.json' with { type: 'json' };

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const OPENROUTER_VARIANT_SUFFIX =
  /:(?:free|extended|thinking|online|nitro|floor|exacto)$/i;
// Placeholder baseUrl stamped on Qwen OAuth models by ModelRegistry. It is
// not a real endpoint and must not count as baseUrl evidence, or it
// suppresses the 'qwen-oauth' → 'alibaba' protocol fallback.
const QWEN_OAUTH_PLACEHOLDER_BASE_URL = 'DYNAMIC_QWEN_OAUTH_BASE_URL';

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

export type ModelModalitiesSource = 'explicit' | 'catalog' | 'heuristic';

interface CatalogState {
  current?: ModelMetadataCatalog;
  loading?: Promise<ModelMetadataCatalog>;
  refresh?: Promise<void>;
  refreshTimer?: ReturnType<typeof setTimeout>;
  options?: LoadModelMetadataCatalogOptions;
  lastRefreshAttemptAt?: number;
  lastSuccessfulRefreshAt?: number;
}

const builtInCatalog = Object.assign(
  Object.create(null),
  builtInModelModalities,
) as ModelMetadataCatalog;
const catalogStates = new Map<string, CatalogState>();

function hasSameLoadOptions(
  left: LoadModelMetadataCatalogOptions | undefined,
  right: LoadModelMetadataCatalogOptions,
): boolean {
  if (!left) return false;
  return (
    left?.cachePath === right.cachePath &&
    left?.proxyUrl === right.proxyUrl &&
    left?.fetch === right.fetch
  );
}

function isCatalogFresh(state: CatalogState): boolean {
  return (
    state.lastSuccessfulRefreshAt !== undefined &&
    Date.now() - state.lastSuccessfulRefreshAt < CACHE_TTL_MS
  );
}

function isRefreshBackoffActive(state: CatalogState): boolean {
  return (
    state.lastRefreshAttemptAt !== undefined &&
    Date.now() - state.lastRefreshAttemptAt < CACHE_TTL_MS
  );
}

function getCachePath(): string {
  return path.join(Storage.getGlobalQwenDir(), 'models-dev.json');
}

function parseCatalog(text: string): ModelMetadataCatalog | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const catalog = Object.create(null) as ModelMetadataCatalog;
    let modelCount = 0;
    for (const [providerId, provider] of Object.entries(parsed)) {
      if (
        !provider ||
        typeof provider !== 'object' ||
        Array.isArray(provider)
      ) {
        continue;
      }
      const { api, env, models } = provider as CatalogProvider;
      if (api !== undefined && typeof api !== 'string') continue;
      if (
        env !== undefined &&
        (!Array.isArray(env) || env.some((key) => typeof key !== 'string'))
      ) {
        continue;
      }
      if (!models || typeof models !== 'object' || Array.isArray(models)) {
        continue;
      }
      const validModels = Object.create(null) as Record<string, CatalogModel>;
      for (const [modelId, model] of Object.entries(models)) {
        if (Array.isArray(model)) {
          if (model.some((modality) => typeof modality !== 'string')) {
            continue;
          }
        } else {
          if (!model || typeof model !== 'object') continue;
          if (model.id !== undefined && typeof model.id !== 'string') continue;
          if (
            model.attachment !== undefined &&
            typeof model.attachment !== 'boolean'
          ) {
            continue;
          }
          const input = model.modalities?.input;
          if (
            input !== undefined &&
            (!Array.isArray(input) ||
              input.some((modality) => typeof modality !== 'string'))
          ) {
            continue;
          }
          if (input === undefined && model.attachment !== true) {
            continue;
          }
        }
        validModels[modelId] = model;
        modelCount += 1;
      }
      if (Object.keys(validModels).length === 0) continue;
      catalog[providerId] = {
        ...(api !== undefined ? { api } : {}),
        ...(env !== undefined ? { env } : {}),
        models: validModels,
      };
    }
    return modelCount > 0 ? catalog : undefined;
  } catch {
    return undefined;
  }
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`models.dev returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_CATALOG_BYTES) {
    await response.body?.cancel().catch(() => undefined);
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
  const insecure = isTlsVerificationDisabled();
  let response: Response;
  let closeDispatcher: (() => Promise<void>) | undefined;

  if (fetchOverride) {
    response = await fetchOverride(MODELS_DEV_URL, { signal });
  } else if (proxyUrl) {
    const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
    const { EnvHttpProxyAgent, fetch: undiciFetch } = await loadUndici();
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy: normalizedProxyUrl,
      httpsProxy: normalizedProxyUrl,
      // Mirrors getOrCreateSharedDispatcher: `connect` covers a direct NO_PROXY
      // connection, `requestTls` the origin through a proxy, and `proxyTls` an
      // HTTPS proxy itself.
      ...(insecure
        ? {
            connect: { rejectUnauthorized: false },
            requestTls: { rejectUnauthorized: false },
            proxyTls: { rejectUnauthorized: false },
          }
        : {}),
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
  } else if (insecure) {
    const { Agent, fetch: undiciFetch } = await loadUndici();
    const dispatcher = new Agent({
      connect: { rejectUnauthorized: false },
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
  delayMs: number,
): void {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = undefined;
    refreshCatalog(state, cachePath, true);
  }, delayMs);
  state.refreshTimer.unref();
}

function refreshCatalog(
  state: CatalogState,
  cachePath: string,
  keepFresh: boolean,
  allowOptionsHandoff = true,
): void {
  if (state.refresh) return;

  const refreshOptions = state.options ?? {};
  state.lastRefreshAttemptAt = Date.now();
  state.refresh = fetchAndCache(cachePath, refreshOptions)
    .then((catalog) => {
      state.current = catalog;
      state.lastSuccessfulRefreshAt = Date.now();
    })
    .catch((error) => {
      debugLogger.debug(
        'Failed to refresh models.dev catalog:',
        redactProxyError(error),
      );
    })
    .finally(() => {
      state.refresh = undefined;
      if (
        allowOptionsHandoff &&
        state.options !== refreshOptions &&
        !isCatalogFresh(state)
      ) {
        refreshCatalog(state, cachePath, keepFresh, false);
        return;
      }
      if (keepFresh) {
        scheduleRefresh(state, cachePath, CACHE_TTL_MS);
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
      state.lastSuccessfulRefreshAt = stat.mtimeMs;
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs >= CACHE_TTL_MS) {
        refreshCatalog(state, cachePath, keepFresh);
      } else if (keepFresh) {
        scheduleRefresh(state, cachePath, CACHE_TTL_MS - ageMs);
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
  refreshCatalog(state, cachePath, keepFresh);
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
  const optionsChanged = !hasSameLoadOptions(state.options, options);
  if (optionsChanged) state.options = options;

  if (state.current) {
    if (
      optionsChanged &&
      options.cachePath === undefined &&
      !isCatalogFresh(state) &&
      !isRefreshBackoffActive(state)
    ) {
      refreshCatalog(state, cachePath, true);
    }
    return Promise.resolve(state.current);
  }

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
  configuredProviderId: string | undefined,
): string | undefined {
  const sourceProviderId = configuredProviderId ?? lookup.providerId;
  const normalizedBaseUrl = normalizeUrl(
    lookup.baseUrl === QWEN_OAUTH_PLACEHOLDER_BASE_URL
      ? undefined
      : lookup.baseUrl,
  );
  if (normalizedBaseUrl) {
    const endpointMatches = Object.entries(catalog).filter(
      ([, provider]) => normalizeUrl(provider.api) === normalizedBaseUrl,
    );
    const modelMatch = endpointMatches.find(([providerId, provider]) =>
      findCatalogModel(provider, providerId, sourceProviderId, lookup.modelId),
    );
    if (modelMatch) return modelMatch[0];
    if (endpointMatches[0]) return endpointMatches[0][0];
  }

  const canonicalProtocolBaseUrl = normalizeUrl(
    getDefaultBaseUrlForProtocol(lookup.authType as AuthType | undefined),
  );
  if (normalizedBaseUrl && normalizedBaseUrl === canonicalProtocolBaseUrl) {
    const protocolProviderId = mapProviderId(lookup.authType);
    if (protocolProviderId && catalog[protocolProviderId]) {
      return protocolProviderId;
    }
  }

  if (sourceProviderId === 'idealab') {
    const idealabProviderId = mapIdealabProvider(lookup.modelId);
    if (idealabProviderId && catalog[idealabProviderId]) {
      return idealabProviderId;
    }
  }
  const configuredId = mapProviderId(
    configuredProviderId,
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
  const configuredProviderId = findProviderByCredentials(
    lookup.baseUrl,
    lookup.envKey,
  )?.id;
  const providerId = resolveCatalogProviderId(
    catalog,
    lookup,
    configuredProviderId,
  );
  if (!providerId) return undefined;

  const sourceProviderId = configuredProviderId ?? lookup.providerId;

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
