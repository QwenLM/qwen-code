/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolErrorType } from './tool-error.js';

/**
 * Resolved endpoint and credentials for the search side request, as produced
 * by the gate in `web-search.ts` and consumed by a backend implementation.
 * `kind` selects that implementation.
 */
export interface WebSearchBackendConfig {
  kind: 'dashscope';
  modelId: string;
  /** Environment variable name holding the API key. */
  apiKeyEnvKey?: string;
  /** Resolved literal credential when the primary model did not use an env var. */
  apiKey?: string;
  baseUrl: string;
  /** Whether the search agent may open result pages (web_extractor). */
  webExtractor: boolean;
  /**
   * Total wall-clock budget for one search in ms, covering every attempt.
   * Resolved by the gate from `tools.webSearch.timeoutMs`.
   */
  timeoutMs: number;
  /**
   * Custom headers from the entry's generationConfig — internal gateways
   * accepted by the baseUrl check may require routing/auth headers.
   */
  customHeaders?: Record<string, string>;
}

/** One page the search produced. */
export interface WebSearchSource {
  url: string;
  /**
   * True when the backend's extractor opened the page and did not report
   * failure — treated as stronger evidence.
   */
  opened: boolean;
}

/** What a successful search hands back to the tool for formatting. */
export interface WebSearchOutcome {
  /**
   * Narrated answer from the search side model, or salvaged extracted page
   * text when no narration arrived; may be empty.
   */
  answerText: string;
  /** Opened pages first, then the unopened candidates. De-duplicated. */
  sources: WebSearchSource[];
  executedQueries: string[];
  /** Search calls performed — the count shown in the tool's display line. */
  searchCount: number;
  /**
   * Set when the backend salvaged an incomplete or interrupted response, so
   * the model is told the evidence may be missing pieces.
   */
  partialNote?: string;
}

export type WebSearchBackendResult =
  | { ok: true; outcome: WebSearchOutcome }
  | { ok: false; message: string; errorType: ToolErrorType };

export interface WebSearchBackendRequest {
  query: string;
  /** Caller cancellation. Backends combine it with their own budgets. */
  signal: AbortSignal;
  /** Streaming progress for the tool's live display line. */
  onProgress?: (text: string) => void;
}

/**
 * A provider-side web search implementation.
 *
 * The tool owns everything a user sees — permissions, the result envelope,
 * truncation, the citation policy and the safety footer — and a backend owns
 * only how one provider is asked to search and how its response maps onto
 * {@link WebSearchOutcome}. Backends report failure as a message plus a
 * {@link ToolErrorType} rather than a formatted result, so every provider's
 * errors reach the model through the same envelope.
 */
export interface WebSearchBackend {
  search(request: WebSearchBackendRequest): Promise<WebSearchBackendResult>;
}

/**
 * `String#slice` counts UTF-16 code units and can cut a surrogate pair in
 * half, leaving a lone surrogate that breaks serialization of the next model
 * request. Back off one unit when the cut lands after a high surrogate.
 *
 * Shared by the result formatter and by backends that bound text they relay.
 */
export function sliceAtCharBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}
