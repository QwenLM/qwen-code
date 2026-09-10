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
   * Custom headers from the entry's generationConfig — internal gateways
   * accepted by the baseUrl check may require routing/auth headers.
   */
  customHeaders?: Record<string, string>;
}

/**
 * Per-tier render caps. The formatter bounds each evidence section to this
 * many pages, and the DashScope backend reads the same values so the lines it
 * removes from a narration are exactly the ones the formatter will render —
 * a page dropped from both would vanish from the result entirely.
 */
export const MAX_OPENED_URLS = 25;
export const MAX_CANDIDATE_URLS = 25;

/**
 * One page the search produced. `title` is present only when the backend
 * actually learned it — the tool renders a titled markdown link when it did
 * and a bare URL when it did not, so a backend that cannot supply titles
 * keeps producing exactly the output it produced before.
 */
export interface WebSearchSource {
  url: string;
  title?: string;
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
   * text when the stream died before any narration arrived; may be empty.
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
 * Shared by the result formatter and by backends that bound field lengths.
 */
export function sliceAtCharBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}
