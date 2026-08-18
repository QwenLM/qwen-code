/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model discovery — asks an OpenAI-compatible provider which models it
 * currently serves (`GET {baseUrl}/models`) so the setup wizard can recommend
 * the live catalog instead of a list frozen at release time.
 *
 * Discovery is strictly additive to the built-in `ModelSpec` lists: `/models`
 * returns bare ids, so every piece of metadata the runtime needs
 * (`contextWindowSize`, `enableThinking`, `modalities`, …) still comes from
 * the static spec for that id. A provider that cannot be reached, answers
 * with anything unexpected, or serves nothing chat-shaped leaves the built-in
 * list in place — the wizard must never block or fail on this call.
 */

import { fetchWithPolicy } from '../utils/fetch.js';
import type { ModelSpec } from './types.js';

/**
 * Whole-transfer budget. Short on purpose: this runs while the user is
 * looking at the model step, and the built-in list is a perfectly good
 * answer, so waiting longer than a few seconds only costs the user time.
 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;

/** A `/models` listing is a few KB; anything near this is not one. */
const MODEL_DISCOVERY_MAX_BYTES = 1024 * 1024;

/**
 * Same-host, same-protocol redirects only — the transport's redirect guard
 * requires identical protocol, port, and hostname, so a scheme upgrade or a
 * host change is never followed and surfaces as a `'network'` failure.
 */
const MODEL_DISCOVERY_MAX_REDIRECTS = 3;

export type ModelDiscoveryFailureReason =
  /** 404 — the endpoint does not implement `/models`. */
  | 'unsupported'
  /** 401/403 — the key was rejected (wrong key, or wrong region for it). */
  | 'unauthorized'
  /** Any other non-2xx. */
  | 'http'
  /** DNS/TLS/timeout/abort/cross-host redirect. */
  | 'network'
  /** 2xx whose body is not a model listing we recognize. */
  | 'malformed'
  /** A well-formed listing with no chat-capable model in it. */
  | 'empty';

export interface ModelDiscoverySuccess {
  ok: true;
  /** Chat-capable model ids, in the order the provider returned them. */
  ids: string[];
}

export interface ModelDiscoveryFailure {
  ok: false;
  reason: ModelDiscoveryFailureReason;
  /** Diagnostic detail — for logs, not for the wizard's inline notice. */
  message: string;
}

export type ModelDiscoveryResult =
  | ModelDiscoverySuccess
  | ModelDiscoveryFailure;

export interface ModelDiscoveryOptions {
  /** Provider base URL, e.g. `https://.../compatible-mode/v1`. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer`. Optional — some catalogs are public. */
  apiKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Non-chat filtering
// ---------------------------------------------------------------------------

/**
 * `/models` returns bare ids with no capability field, so telling a chat model
 * apart from an image/speech/embedding endpoint can only be a name heuristic.
 * It is deliberately biased towards keeping things: a chat model wrongly
 * dropped from the recommendations is still reachable by typing its id, while
 * a text-to-image endpoint offered as a coding model is a dead end.
 */
const NON_CHAT_MODEL_PATTERNS: readonly RegExp[] = [
  // Embeddings / rerankers — no chat completions endpoint at all.
  /embedding/i,
  /(^|[-_.])rerank/i,
  // Speech: synthesis, recognition, and the Alibaba/OpenAI model families.
  /(^|[-_.])tts([-_.]|$)/i,
  /(^|[-_.])asr([-_.]|$)/i,
  /(^|[-_.])audio([-_.]|$)/i,
  /(^|[-_.])speech/i,
  /cosyvoice|sambert|paraformer|whisper/i,
  // Image and video generation (wan*, qwen-image, *-image-edit, …).
  /(^|[-_.])image([-_.]|$)/i,
  /(^|[-_.])video([-_.]|$)/i,
  /^wan(x|\d)/i,
  /stable-diffusion|flux/i,
  // Safety classifiers.
  /(^|[-_.])moderation/i,
];

/** Whether `id` looks like a model the CLI can hold a conversation with. */
export function isChatCapableModelId(id: string): boolean {
  return !NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(id));
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Pulls model ids out of a `/models` body. OpenAI's shape is
 * `{ data: [{ id }] }`, but gateways in the wild also answer with a bare
 * array, a `models` key, or plain strings instead of objects — all cheap to
 * accept, and the alternative is a silent fallback to the static list.
 */
export function parseModelListResponse(payload: unknown): string[] | null {
  const entries = extractEntries(payload);
  if (!entries) return null;

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const id = extractId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  // A listing whose entries carry no usable id is malformed, not empty; an
  // genuinely empty `data: []` is a valid (if useless) answer.
  if (ids.length === 0 && entries.length > 0) return null;
  return ids;
}

function extractEntries(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'models']) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function extractId(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.trim() || undefined;
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  for (const key of ['id', 'model', 'name']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function buildModelsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/models`;
}

/**
 * Asks the provider for its current model list. Never throws: every failure
 * mode is reported as a `ModelDiscoveryFailure` so callers can fall back to
 * the built-in list without a try/catch.
 */
export async function fetchProviderModelIds(
  options: ModelDiscoveryOptions,
): Promise<ModelDiscoveryResult> {
  const baseUrl = options.baseUrl?.trim() ?? '';
  if (!/^https?:\/\//i.test(baseUrl)) {
    return {
      ok: false,
      reason: 'network',
      message: `Invalid base URL: ${baseUrl}`,
    };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = options.apiKey?.trim();
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let result;
  try {
    result = await fetchWithPolicy(buildModelsUrl(baseUrl), {
      timeoutMs: options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS,
      maxBytes: MODEL_DISCOVERY_MAX_BYTES,
      maxRedirects: MODEL_DISCOVERY_MAX_REDIRECTS,
      headers,
      // 403 is classified below as a deterministic auth failure, and the whole
      // budget is a few seconds the user spends waiting — re-sending a doomed
      // request, or burning half the budget on a 429 delay, buys nothing the
      // built-in list does not already give.
      retryTransientStatuses: false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.kind !== 'response') {
    return {
      ok: false,
      reason: 'network',
      message: `Cross-host redirect to ${result.redirectUrl}`,
    };
  }

  if (result.status === 404) {
    return {
      ok: false,
      reason: 'unsupported',
      message: `${result.status} ${result.statusText}`,
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      reason: 'unauthorized',
      message: `${result.status} ${result.statusText}`,
    };
  }
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      reason: 'http',
      message: `${result.status} ${result.statusText}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.body.toString('utf8'));
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const ids = parseModelListResponse(payload);
  if (!ids) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'Response is not an OpenAI-compatible model listing',
    };
  }

  const chatIds = ids.filter(isChatCapableModelId);
  if (chatIds.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: `No chat-capable models among ${ids.length} returned ids`,
    };
  }

  return { ok: true, ids: chatIds };
}

// ---------------------------------------------------------------------------
// Merge with built-in specs
// ---------------------------------------------------------------------------

/**
 * Rebuilds the recommendation list around what the provider actually serves.
 *
 * Built-in specs whose id is still served keep their full metadata and their
 * curated order (the lists are ordered best-first, and discovery has no
 * opinion worth losing that to); ids the provider added since the release are
 * appended as bare specs. Built-in ids the provider no longer serves are
 * dropped — recommending a retired model is the bug this exists to fix.
 */
export function mergeDiscoveredModels(
  staticModels: readonly ModelSpec[] | undefined,
  discoveredIds: readonly string[],
): ModelSpec[] {
  const served = new Set(discoveredIds);
  const known = new Map((staticModels ?? []).map((spec) => [spec.id, spec]));

  const merged: ModelSpec[] = (staticModels ?? []).filter((spec) =>
    served.has(spec.id),
  );
  for (const id of discoveredIds) {
    if (!known.has(id)) merged.push({ id });
  }
  return merged;
}
