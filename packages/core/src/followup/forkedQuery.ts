/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Forked Query Infrastructure
 *
 * Enables cache-aware secondary LLM calls that share the main conversation's
 * prompt prefix (systemInstruction + history) for cache hits.
 *
 * DashScope already enables cache_control via X-DashScope-CacheControl header.
 * By constructing the forked GeminiChat with identical generationConfig and
 * history prefix, the fork automatically benefits from prefix caching.
 *
 * Note: `runForkedQuery` overrides `tools: []` at the per-request level so the
 * model cannot produce function calls. `createForkedChat` retains the full
 * generationConfig (including tools) for callers like speculation that need them.
 */

import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { GeminiChat, StreamEventType } from '../core/geminiChat.js';
import type { Config } from '../config/config.js';

/** Per-request config that strips tools so the model never produces function calls. */
const NO_TOOLS: GenerateContentConfig = Object.freeze({ tools: [] });

/**
 * Snapshot of the main conversation's cache-critical parameters.
 * Captured after each successful main turn so forked queries share the same prefix.
 */
export interface CacheSafeParams {
  /** Full generation config including systemInstruction and tools */
  generationConfig: GenerateContentConfig;
  /** Curated conversation history (deep clone) */
  history: Content[];
  /** Model identifier */
  model: string;
  /** Version number — increments when systemInstruction or tools change */
  version: number;
}

/**
 * Result from a forked query.
 */
export interface ForkedQueryResult {
  /** Extracted text response, or null if no text */
  text: string | null;
  /** Parsed JSON result if schema was provided */
  jsonResult?: Record<string, unknown>;
  /** Token usage metrics */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Global cache params slot
// ---------------------------------------------------------------------------

let currentCacheSafeParams: CacheSafeParams | null = null;
let currentVersion = 0;

/**
 * Save cache-safe params after a successful main conversation turn.
 * Called from GeminiClient.sendMessageStream() on successful completion.
 */
export function saveCacheSafeParams(
  generationConfig: GenerateContentConfig,
  history: Content[],
  model: string,
): void {
  // Detect if systemInstruction or tools changed
  const prevConfig = currentCacheSafeParams?.generationConfig;
  const sysChanged =
    !prevConfig ||
    JSON.stringify(prevConfig.systemInstruction) !==
      JSON.stringify(generationConfig.systemInstruction);
  const toolsChanged =
    !prevConfig ||
    JSON.stringify(prevConfig.tools) !== JSON.stringify(generationConfig.tools);

  if (sysChanged || toolsChanged) {
    currentVersion++;
  }

  currentCacheSafeParams = {
    generationConfig: structuredClone(generationConfig),
    history, // caller passes structuredClone'd curated history (from getHistory(true))
    model,
    version: currentVersion,
  };
}

/**
 * Get the current cache-safe params, or null if not yet captured.
 */
export function getCacheSafeParams(): CacheSafeParams | null {
  return currentCacheSafeParams
    ? structuredClone(currentCacheSafeParams)
    : null;
}

/**
 * Clear cache-safe params (e.g., on session reset).
 */
export function clearCacheSafeParams(): void {
  currentCacheSafeParams = null;
}

// ---------------------------------------------------------------------------
// Forked chat creation
// ---------------------------------------------------------------------------

/**
 * Create an isolated GeminiChat that shares the same cache prefix as the main
 * conversation. The fork uses identical generationConfig (systemInstruction +
 * tools) and history, so DashScope's cache_control mechanism produces cache hits.
 *
 * The fork does NOT have chatRecordingService or telemetryService to avoid
 * polluting the main session's recordings and token counts.
 */
export function createForkedChat(
  config: Config,
  params: CacheSafeParams,
): GeminiChat {
  // Limit history to avoid excessive cost
  const maxHistoryEntries = 40;
  const history =
    params.history.length > maxHistoryEntries
      ? params.history.slice(-maxHistoryEntries)
      : params.history;

  // params.generationConfig and params.history are already deep-cloned snapshots
  // from saveCacheSafeParams (which clones generationConfig) and getHistory(true)
  // (which structuredClones the history). Slice creates a new array but shares
  // Content references — GeminiChat only reads history, never mutates entries,
  // so sharing is safe and avoids a redundant deep clone.
  return new GeminiChat(
    config,
    {
      ...params.generationConfig,
      // Disable thinking for forked queries — suggestions/speculation don't need
      // reasoning tokens and it wastes cost + latency on the fast model path.
      // This doesn't affect cache prefix (system + tools + history).
      thinkingConfig: { includeThoughts: false },
    },
    [...history], // shallow copy — entries are read-only
    undefined, // no chatRecordingService
    undefined, // no telemetryService
  );
}

// ---------------------------------------------------------------------------
// Forked query execution
// ---------------------------------------------------------------------------

function extractUsage(
  metadata?: GenerateContentResponseUsageMetadata,
): ForkedQueryResult['usage'] {
  return {
    inputTokens: metadata?.promptTokenCount ?? 0,
    outputTokens: metadata?.candidatesTokenCount ?? 0,
    cacheHitTokens: metadata?.cachedContentTokenCount ?? 0,
  };
}

/**
 * Run a forked query using a GeminiChat that shares the main conversation's
 * cache prefix. This is a single-turn, tool-free request (no function calls).
 *
 * @param config - App config
 * @param userMessage - The user message to send (e.g., SUGGESTION_PROMPT)
 * @param options - Optional configuration
 * @returns Query result with text, optional JSON, and usage metrics
 */
export async function runForkedQuery(
  config: Config,
  userMessage: string,
  options?: {
    abortSignal?: AbortSignal;
    /** JSON schema for structured output */
    jsonSchema?: Record<string, unknown>;
    /** Override model (e.g., for speculation with a cheaper model) */
    model?: string;
  },
): Promise<ForkedQueryResult> {
  const params = getCacheSafeParams();
  if (!params) {
    throw new Error('CacheSafeParams not available');
  }

  const model = options?.model ?? params.model;
  const chat = createForkedChat(config, params);

  // Build per-request config overrides.
  // NO_TOOLS prevents the model from producing function calls — forked
  // queries are pure text completion and must not appear in tool-call UI.
  const requestConfig: GenerateContentConfig = { ...NO_TOOLS };
  if (options?.abortSignal) {
    requestConfig.abortSignal = options.abortSignal;
  }
  if (options?.jsonSchema) {
    requestConfig.responseMimeType = 'application/json';
    requestConfig.responseJsonSchema = options.jsonSchema;
  }

  const stream = await chat.sendMessageStream(
    model,
    {
      message: [{ text: userMessage }],
      config: Object.keys(requestConfig).length > 0 ? requestConfig : undefined,
    },
    'forked_query',
  );

  // Collect the full response
  let fullText = '';
  let usage: ForkedQueryResult['usage'] = {
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
  };

  for await (const event of stream) {
    if (event.type !== StreamEventType.CHUNK) continue;
    const response = event.value;
    // Extract text from candidates
    const text = response.candidates?.[0]?.content?.parts
      ?.map((p) => p.text ?? '')
      .join('');
    if (text) {
      fullText += text;
    }
    if (response.usageMetadata) {
      usage = extractUsage(response.usageMetadata);
    }
  }

  const trimmed = fullText.trim() || null;

  // Parse JSON if schema was provided
  let jsonResult: Record<string, unknown> | undefined;
  if (options?.jsonSchema && trimmed) {
    try {
      jsonResult = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Model returned non-JSON despite schema constraint — treat as text
    }
  }

  return { text: trimmed, jsonResult, usage };
}
