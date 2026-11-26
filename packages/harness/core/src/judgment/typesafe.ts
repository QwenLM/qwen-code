/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { JudgmentInputTooLongError } from './types.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  Judge,
  JudgeOptions,
  JudgmentRequest,
  JudgmentResult,
  Questions,
} from './types.js';
import type { TypeSafeJudgmentSettings } from './settings.js';
import {
  parseNativeJudgmentResponse,
  validateJudgmentRequest,
} from './validation.js';

export type JudgmentRequestFn = (
  url: string,
  init: RequestInit,
  options: {
    operation: string;
    requestId: string;
    requestTimeoutMs: number;
    singleAttempt?: boolean;
  },
) => Promise<Response>;

function addErrorMetadata(
  error: unknown,
  requestId: string,
  httpStatus?: number,
): void {
  if (!error || typeof error !== 'object') return;
  try {
    Object.defineProperties(error, {
      requestId: { value: requestId },
      ...(httpStatus === undefined
        ? {}
        : { httpStatus: { value: httpStatus } }),
    });
  } catch {
    // Preserve the original failure.
  }
}

export class TypeSafeJudge implements Judge {
  readonly label: string;
  constructor(
    private readonly settings: TypeSafeJudgmentSettings,
    private readonly send: JudgmentRequestFn,
  ) {
    this.label = `typesafe/${settings.model}`;
  }
  async judge<Q extends Questions>(
    request: JudgmentRequest<Q>,
    options: JudgeOptions = {},
  ): Promise<JudgmentResult<Q>> {
    const { signal, sideEffectFree = false } = options;
    signal?.throwIfAborted();
    validateJudgmentRequest(request);
    const body = JSON.stringify({
      state: request.state,
      model: this.settings.model,
      questions: request.questions,
    });
    const requestId = randomUUID();
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.send(
          `${this.settings.baseUrl.replace(/\/+$/, '')}/v1/systemone`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.settings.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body,
            signal,
          },
          {
            operation: 'judgment.typesafe',
            requestId,
            requestTimeoutMs: 10_000,
            ...(sideEffectFree ? { singleAttempt: true } : {}),
          },
        );
      } catch (error) {
        if (signal?.aborted || sideEffectFree || attempt >= 2) {
          addErrorMetadata(error, requestId);
          throw error;
        }
        await delay(500 * 2 ** attempt, undefined, { signal });
        continue;
      }
      if (!response.ok) {
        // TypeSafe's explicit token-limit response. Never infer this from
        // arbitrary error text, authorization failures, or generic HTTP 400s.
        if (response.status === 400) {
          const error = await response.json().catch(() => undefined);
          if (error?.detail?.error_type === 'max_tokens_exceeded') {
            const tooLong = new JudgmentInputTooLongError();
            addErrorMetadata(tooLong, requestId, response.status);
            throw tooLong;
          }
        } else {
          await response.body?.cancel();
        }
        const transient =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        if (!transient || sideEffectFree || attempt >= 2) {
          const error = new Error(
            `TypeSafe judgment request failed (HTTP ${response.status})`,
          );
          addErrorMetadata(error, requestId, response.status);
          throw error;
        }
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const hint = Number.isFinite(seconds)
          ? seconds * 1000
          : retryAfter
            ? Date.parse(retryAfter) - Date.now()
            : NaN;
        await delay(
          Number.isFinite(hint)
            ? Math.min(5000, Math.max(0, hint))
            : 500 * 2 ** attempt,
          undefined,
          { signal },
        );
        continue;
      }
      try {
        const data: unknown = await response.json();
        signal?.throwIfAborted();
        const result = parseNativeJudgmentResponse(
          data,
          request.questions,
          'TypeSafe',
        );
        return {
          api: 'typesafe',
          provider: 'typesafe',
          model: result.model,
          answers: result.answers as JudgmentResult<Q>['answers'],
          requestId,
          usage: result.usage
            ? {
                inputTokens: result.usage.input_tokens,
                outputTokens: result.usage.output_tokens,
              }
            : undefined,
        };
      } catch (error) {
        addErrorMetadata(error, requestId);
        throw error;
      }
    }
  }
}
