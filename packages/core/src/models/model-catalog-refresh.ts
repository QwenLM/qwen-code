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
/** `QWEN_CODE_MODELS_DEV_REFRESH=off` stops the once-a-day download; a downloaded cache still serves while it is newer than the bundled snapshot. */
export const MODEL_CATALOG_REFRESH_ENV = 'QWEN_CODE_MODELS_DEV_REFRESH';
/** Replaces the models.dev URL, e.g. with a corporate mirror. */
export const MODEL_CATALOG_URL_ENV = 'QWEN_CODE_MODELS_DEV_URL';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * models.dev providers whose token limits feed the catalog. Conflicting
 * normalized ids lose their limits so endpoint-specific values fall back to
 * existing tables. Third-party routers are left out — they republish vendor
 * models under their own aliases and limits. Modalities are not gated by
 * this list: they describe the weights, not the endpoint, so every provider
 * that serves a model contributes them (see trimModelsDevCatalog).
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

type Limits = Pick<ModelCatalogEntry, 'context' | 'output'>;

function toLimits(model: ModelsDevModel): Limits | undefined {
  const limits: Limits = {};
  const context = model.limit?.input || model.limit?.context;
  if (context !== undefined && Number.isSafeInteger(context) && context > 0) {
    limits.context = context;
  }
  if (
    model.limit?.output !== undefined &&
    Number.isSafeInteger(model.limit.output) &&
    model.limit.output > 0
  ) {
    limits.output = model.limit.output;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function toModalities(model: ModelsDevModel): InputModalities | undefined {
  const modalities: InputModalities = {};
  for (const modality of MODALITIES) {
    if (model.modalities?.input?.includes(modality)) {
      modalities[modality] = true;
    }
  }
  return Object.keys(modalities).length > 0 ? modalities : undefined;
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

/** `toLimits` builds its keys in a fixed order, so this compares by value. */
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
 * the same model. Limits and modalities follow different trust rules:
 *
 * A context window or output limit is a property of the endpoint, not of the
 * weights — DashScope caps GLM-5 output at 16,384 while Z.ai allows 131,072,
 * and both numbers are correct for their own endpoint — so only allowlisted
 * providers contribute limits, and if any of them disagree the limits are
 * dropped rather than guessed: the catalog cannot tell which endpoint a
 * request will reach, so such models keep the answer the regex tables give
 * them today.
 *
 * Modalities describe the weights, so every provider that serves the model
 * contributes them, unioned: a first-party vendor outside the allowlist (or a
 * custom endpoint's vendor, e.g. issue #8558's thinkingmachines/inkling)
 * still surfaces image/pdf support. A catalog modality is not a guarantee on
 * every endpoint — the lookup-side corrections handle the endpoint-specific
 * exceptions — so a stray router report can only widen, never replace, what
 * the regex tables and the vendor tables already allow.
 */
export function trimModelsDevCatalog(
  api: ModelsDevApi,
  fetchedAt: string,
  source: string = MODELS_DEV_URL,
): ModelCatalog {
  const limitCandidates = new Map<string, Limits[]>();
  const modalityCandidates = new Map<string, InputModalities[]>();
  for (const [provider, bucket] of Object.entries(api)) {
    const trustedForLimits = MODELS_DEV_PROVIDERS.includes(provider);
    for (const model of Object.values(bucket?.models ?? {})) {
      if (typeof model.id !== 'string' || !servesAgentTurns(model)) {
        continue;
      }
      const key = normalize(model.id);
      // Lookups key on normalize(user input), so a key that is not its own
      // normalized form is unreachable by its own spelling while a dated
      // alias still hits it (`deepseek-v3-0324` -> `deepseek-v3` ->
      // `deepseek`). Omit it so both spellings share the regex answer.
      if (normalize(key) !== key) {
        continue;
      }
      const modalities = toModalities(model);
      if (modalities) {
        const existing = modalityCandidates.get(key);
        if (existing) {
          existing.push(modalities);
        } else {
          modalityCandidates.set(key, [modalities]);
        }
      }
      if (trustedForLimits) {
        const limits = toLimits(model);
        if (limits) {
          const existing = limitCandidates.get(key);
          if (existing) {
            existing.push(limits);
          } else {
            limitCandidates.set(key, [limits]);
          }
        }
      }
    }
  }
  const agreed: Array<readonly [string, ModelCatalogEntry]> = [];
  for (const key of new Set([
    ...limitCandidates.keys(),
    ...modalityCandidates.keys(),
  ])) {
    const entry: ModelCatalogEntry = {};
    const limits = limitCandidates.get(key);
    if (
      limits &&
      limits.every((candidate) => sameEntry(candidate, limits[0]!))
    ) {
      Object.assign(entry, limits[0]);
    }
    const allModalities = modalityCandidates.get(key);
    if (allModalities) {
      entry.modalities = Object.assign({}, ...allModalities);
    }
    if (Object.keys(entry).length > 0) {
      agreed.push([key, entry]);
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
  // A cache with no models is a poisoned write from before the empty-
  // projection guard below; treat it as absent so it heals on this fetch
  // instead of being re-stamped by a 304.
  const reusable =
    cached?.source === url && Object.keys(cached.models).length > 0
      ? cached
      : undefined;
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
    // A 200 that projects to nothing is not a catalog (a renamed upstream
    // field or a gateway error body); keep the previous data instead of
    // shadowing the bundled snapshot with an empty one for a day.
    if (Object.keys(next.models).length === 0) {
      throw new Error(`no catalog entries projected from ${url}`);
    }
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
