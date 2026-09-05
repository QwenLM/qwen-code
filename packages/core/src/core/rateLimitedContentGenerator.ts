/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CountTokensParameters,
  CountTokensResponse,
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { ContentGenerator } from './contentGenerator.js';
import type { ConcurrencyLimiter } from '../utils/concurrencyLimiter.js';

/**
 * Wraps a ``ContentGenerator`` and gates concurrent ``generateContent`` /
 * ``generateContentStream`` calls behind a semaphore so a configured
 * per-provider cap (#3409) prevents the upstream
 * ``429 Too many concurrent requests for this model`` error from ever firing.
 *
 * - ``countTokens`` and ``embedContent`` are intentionally **not** gated:
 *   they are cheap, often local, and rate-limit responses there are rare.
 * - For streaming, the slot is held until the consumer fully drains the
 *   iterator (or it errors / aborts). This matches what the rate-limit
 *   actually counts: an open connection, not just request initiation.
 * - When the limiter has no cap (``capacity <= 0``), this wrapper is a
 *   thin pass-through with a single ``await Promise.resolve()`` worth of
 *   overhead.
 */
export class RateLimitedContentGenerator implements ContentGenerator {
  constructor(
    private readonly wrapped: ContentGenerator,
    private readonly limiter: ConcurrencyLimiter,
  ) {}

  /** Exposed for tests / observability. */
  getLimiter(): ConcurrencyLimiter {
    return this.limiter;
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return this.limiter.runExclusive(() =>
      this.wrapped.generateContent(request, userPromptId),
    );
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const release = await this.limiter.acquire();
    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.wrapped.generateContentStream(request, userPromptId);
    } catch (error) {
      release();
      throw error;
    }
    return this.gateStream(stream, release);
  }

  countTokens(request: CountTokensParameters): Promise<CountTokensResponse> {
    return this.wrapped.countTokens(request);
  }

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse> {
    return this.wrapped.embedContent(request);
  }

  useSummarizedThinking(): boolean {
    return this.wrapped.useSummarizedThinking();
  }

  /**
   * Wrap the underlying iterator so the slot is released exactly once,
   * regardless of how iteration ends -- normal completion, thrown error,
   * caller-side ``return()`` (e.g. consumer unwound a ``for await`` early),
   * or upstream abort.
   */
  private async *gateStream(
    stream: AsyncGenerator<GenerateContentResponse>,
    release: () => void,
  ): AsyncGenerator<GenerateContentResponse> {
    try {
      for await (const chunk of stream) {
        yield chunk;
      }
    } finally {
      release();
    }
  }
}
