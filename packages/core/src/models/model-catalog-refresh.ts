/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { InputModalities } from '../core/contentGenerator.js';
import {
  MIN_AUTO_DETECTED_CONTEXT_WINDOW,
  normalize,
} from '../core/tokenLimits.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  CATALOG_MODALITIES,
  getModelCatalogCachePath,
  isModelCatalogDisabled,
  isModelCatalogKey,
  MODEL_CATALOG_PROJECTION_VERSION,
  MODEL_CATALOG_URL_ENV,
  MODELS_DEV_URL,
  parseModelCatalog,
  type ModelCatalog,
  type ModelCatalogEntry,
} from './model-catalog.js';

const debugLogger = createDebugLogger('MODEL_CATALOG');

export { MODEL_CATALOG_URL_ENV, MODELS_DEV_URL } from './model-catalog.js';
/** `QWEN_CODE_MODELS_DEV_REFRESH=off` stops the once-a-day download; a downloaded cache still serves while it is newer than the bundled snapshot. */
export const MODEL_CATALOG_REFRESH_ENV = 'QWEN_CODE_MODELS_DEV_REFRESH';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * models.dev providers whose token limits feed the catalog. Conflicting
 * normalized ids lose their limits so endpoint-specific values fall back to
 * existing tables. Pure mirrors are left out — they republish vendor models
 * under their own aliases and limits, and a mirror's hosted-inference numbers
 * otherwise veto the first-party vendor's (measured 2026-09-30 against the
 * live payload: modelscope's only contributions were four dated `-2507`
 * qwen3 snapshots recorded under the bare ids plus the `glm-4.6` veto, both
 * the harm this list exists to avoid). `volcengine` stays because it is the
 * first-party endpoint for the doubao/seed family — dropping it costs the
 * catalog all 16 of those keys. Modalities are not gated by this list: they
 * describe the weights, not the endpoint, so every provider that serves a
 * model contributes them (see trimModelsDevCatalog).
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

type Limits = Pick<ModelCatalogEntry, 'context' | 'output'>;

function toLimits(model: ModelsDevModel): Limits | undefined {
  const limits: Limits = {};
  const context = model.limit?.input || model.limit?.context;
  if (
    context !== undefined &&
    Number.isSafeInteger(context) &&
    context >= MIN_AUTO_DETECTED_CONTEXT_WINDOW
  ) {
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
  // An absent input list means upstream said nothing; an input list with no
  // known key is a positive text-only declaration, which must survive as {}
  // so a future narrowing can tell the two apart (every allowlisted model on
  // models.dev declares the array).
  if (model.modalities?.input === undefined) {
    return undefined;
  }
  const modalities: InputModalities = {};
  for (const modality of CATALOG_MODALITIES) {
    if (model.modalities.input.includes(modality)) {
      modalities[modality] = true;
    }
  }
  return modalities;
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
 * Modalities describe the weights, so trusted first-party providers contribute
 * them. `thinkingmachines` is included for issue #8558 without trusting its
 * endpoint limits. Router claims are excluded because they can widen a
 * model's capabilities beyond what its owner reports.
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
    const trustedForModalities =
      trustedForLimits || provider === 'thinkingmachines';
    for (const model of Object.values(bucket?.models ?? {})) {
      if (typeof model.id !== 'string' || !servesAgentTurns(model)) {
        continue;
      }
      const key = normalize(model.id);
      // Lookups key on normalize(user input), so a key that is not its own
      // normalized form is unreachable by its own spelling while a dated
      // alias still hits it (`deepseek-v3-0324` -> `deepseek-v3` ->
      // `deepseek`). Omit it so both spellings share the regex answer.
      if (!isModelCatalogKey(key)) {
        continue;
      }
      // DeepSeek models are text-only unless the id names a `vision` variant
      // (#10270); some upstream bare-model records overstate image support.
      // Key on the family root, not the hyphenated prefix: normalize() folds
      // bare-model records onto it (`deepseek-v3` -> `deepseek`), and the
      // root passes isModelCatalogKey, so a `deepseek-`-only guard would let
      // exactly the records it exists for through.
      const modalities =
        /^deepseek(?:-|$)/.test(key) && !key.includes('vision')
          ? undefined
          : toModalities(model);
      if (modalities && trustedForModalities) {
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
      const merged = Object.assign({}, ...allModalities);
      // A declared-text-only record ({}) is kept only on entries that ship
      // limits: there it is fidelity the union can later narrow against. On
      // its own it carries no usable fact, so it must not create an entry —
      // otherwise every conflict-dropped or limit-less model would survive
      // as a bare `{}` marker.
      if (Object.keys(merged).length > 0 || Object.keys(entry).length > 0) {
        entry.modalities = merged;
      }
    }
    if (Object.keys(entry).length > 0) {
      agreed.push([key, entry]);
    }
  }
  return {
    source,
    fetchedAt,
    projection: MODEL_CATALOG_PROJECTION_VERSION,
    models: sortedModels(agreed),
  };
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

// The full upstream feed is several MiB; 200 KiB budgets only the projection.
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

/**
 * Reads a 200 body with a hard size ceiling, so a hostile or broken endpoint
 * cannot make the once-a-day refresh buffer an unbounded payload. A present
 * but non-JSON Content-Type is a gateway error page and fails here, one step
 * earlier than JSON.parse; a missing one is tolerated for bare mirrors.
 */
async function readBoundedCatalogJson(
  response: Response,
): Promise<ModelsDevApi> {
  const contentType = response.headers.get('content-type');
  if (contentType && !contentType.toLowerCase().includes('json')) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`unexpected catalog content type: ${contentType}`);
  }
  if (!response.body) {
    throw new Error('catalog response has no body');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_CATALOG_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(
        `catalog response exceeds the ${MAX_CATALOG_BYTES}-byte budget`,
      );
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelsDevApi;
}

/**
 * A payload missing any allowlisted provider is truncated or partial-mirror
 * data, not a catalog: it must never replace a complete snapshot or cache.
 * This is a coverage check, not an allowlist of who may appear — providers
 * outside MODELS_DEV_PROVIDERS (e.g. thinkingmachines) still contribute
 * modalities. Shared by the runtime refresh and the snapshot generator so
 * both paths reject the same payloads.
 */
export function assertCatalogPayloadComplete(api: ModelsDevApi): void {
  const missingProvider = MODELS_DEV_PROVIDERS.find(
    (provider) => Object.keys(api[provider]?.models ?? {}).length === 0,
  );
  if (missingProvider) {
    throw new Error(`catalog is missing provider ${missingProvider}`);
  }
}

async function refreshRemote(url: string, cachePath: string): Promise<void> {
  const cached = await readCacheFile(cachePath);
  // Old projections and unusable entries must be fetched again, not re-stamped
  // by a 304 that only validates the unchanged upstream payload.
  const reusable =
    cached?.projection === MODEL_CATALOG_PROJECTION_VERSION &&
    cached.source === url &&
    Object.keys(cached.models).some(isModelCatalogKey)
      ? cached
      : undefined;
  if (reusable) {
    const ageMs = Date.now() - Date.parse(reusable.fetchedAt);
    // A negative or unreadable age means the stamp came from a different
    // clock; refetch — the re-stamp below uses the local clock, so a skewed
    // cache self-heals here instead of serving indefinitely.
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < REFRESH_INTERVAL_MS) {
      return;
    }
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
    const api = await readBoundedCatalogJson(response);
    assertCatalogPayloadComplete(api);
    next = trimModelsDevCatalog(api, fetchedAt, url);
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
    // Release the socket: an unconsumed error body pins the connection.
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await atomicWriteJSON(cachePath, next);
  debugLogger.debug(
    `Model catalog refreshed from ${url}: ${Object.keys(next.models).length} models`,
  );
}

let inFlight: Promise<void> | undefined;

/**
 * Best-effort background refresh. Call after installing the proxy dispatcher;
 * the selected catalog stays fixed for this process; the downloaded cache
 * is available to the next process.
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
      debugLogger.debug(
        `Model catalog refresh skipped: ${getErrorMessage(error)}`,
      );
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}
