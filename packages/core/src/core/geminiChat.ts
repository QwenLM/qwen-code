/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// DISCLAIMER: This is a copied version of https://github.com/googleapis/js-genai/blob/main/src/chats.ts with the intention of working around a key bug
// where function responses are not treated as "valid" responses: https://b.corp.google.com/issues/420354090

import type {
  GenerateContentResponse,
  Content,
  GenerateContentConfig,
  GenerateContentParameters,
  SendMessageParameters,
  Part,
  Tool,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { createUserContent, FinishReason } from '@google/genai';
import { retryWithBackoff } from '../utils/retry.js';
import { getErrorStatus } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { parseAndFormatApiError } from '../utils/errorParsing.js';
import { isRateLimitError, type RetryInfo } from '../utils/rateLimit.js';
import type { Config } from '../config/config.js';
import { ESCALATED_MAX_TOKENS } from './tokenLimits.js';
import { hasCycleInSchema } from '../tools/tools.js';
import type { StructuredError } from './turn.js';
import { AuthType } from './contentGenerator.js';
import {
  logContentRetry,
  logContentRetryFailure,
} from '../telemetry/loggers.js';
import { type ChatRecordingService } from '../services/chatRecordingService.js';
import {
  ContentRetryEvent,
  ContentRetryFailureEvent,
} from '../telemetry/types.js';
import type { UiTelemetryService } from '../telemetry/uiTelemetry.js';

const debugLogger = createDebugLogger('QWEN_CODE_CHAT');

export enum StreamEventType {
  /** A regular content chunk from the API. */
  CHUNK = 'chunk',
  /** A signal that a retry is about to happen. The UI should discard any partial
   * content from the attempt that just failed. */
  RETRY = 'retry',
}

export type StreamEvent =
  | { type: StreamEventType.CHUNK; value: GenerateContentResponse }
  | {
      type: StreamEventType.RETRY;
      retryInfo?: RetryInfo;
      /**
       * When true, the retry is a continuation (multi-turn recovery) rather
       * than a fresh restart. The UI should keep the accumulated text buffer
       * so the continuation appends to the existing partial output.
       */
      isContinuation?: boolean;
    };

/**
 * Options for retrying due to invalid content from the model.
 */
interface ContentRetryOptions {
  /** Total number of attempts to make (1 initial + N retries). */
  maxAttempts: number;
  /** The base delay in milliseconds for linear backoff. */
  initialDelayMs: number;
}

const INVALID_CONTENT_RETRY_OPTIONS: ContentRetryOptions = {
  maxAttempts: 2, // 1 initial call + 1 retry
  initialDelayMs: 500,
};

// Some providers occasionally return transient stream anomalies: either an
// empty stream (usage metadata only, no candidates), a stream that finishes
// normally but contains no usable text, or a stream cut off without a finish
// reason. All are retried with an independent budget (similar to rate-limit
// retries) so they do not consume each other's retry budgets.
const INVALID_STREAM_RETRY_CONFIG = {
  /**
   * Maximum number of retries for transient stream errors (NO_FINISH_REASON,
   * NO_RESPONSE_TEXT, EMPTY_STREAM).
   *
   * Raised from 2 → 3 after production traces (sessions 188c5d3e, 934160dd)
   * showed DashScope NO_FINISH_REASON storms lasting 2–3 minutes.
   *
   * Raised from 3 → 5 after observing EMPTY_STREAM cases in DataWorks /
   * PAI / glm-5 (session bb9759c4) where the first few attempts may all
   * return zero chunks but later attempts can recover. With linear back-off
   * (3+6+9+12+15s = 45 s total wait), five retries cover ~45 s of provider
   * recovery window. Beyond that, the user can press Ctrl+Y for manual
   * retry on the surfaced error — manual retries are the right tool for
   * "stable empty" failures (auth/quota/filter) where the cause likely
   * needs out-of-band intervention.
   */
  maxRetries: 5,
  /**
   * Initial delay in milliseconds; multiplied by (retryCount) for linear
   * back-off: 3 s → 6 s → 9 s → 12 s → 15 s.
   *
   * Raised from 2 s after production traces showed DashScope
   * NO_FINISH_REASON bursts lasting 2–3 minutes under /review fan-out.
   */
  initialDelayMs: 3000,
};

/**
 * Options for retrying on rate-limit throttling errors returned as stream content.
 * Fixed 60s delay matches the DashScope per-minute quota window.
 * 10 retries aligns with Claude Code's retry behavior.
 */
const RATE_LIMIT_RETRY_OPTIONS = {
  maxRetries: 10,
  delayMs: 60000,
};

/**
 * Maximum multi-turn recovery attempts for the mid-stream cut-off path.
 * Each attempt keeps the partial response in history and injects a recovery
 * user message so the model can continue from where it left off.
 *
 * Triggered when a stream closes without a finishReason while text is
 * already being produced (e.g. DataWorks gateway idle timeout mid-response,
 * seen in prod session ca35fb55).
 */
const MAX_OUTPUT_RECOVERY_ATTEMPTS = 3;

/**
 * Recovery message for the "stream cut off mid-response" scenario (no
 * finishReason, no tool call, but text already delivered). Injected as a
 * user turn so the model resumes the response it was about to complete.
 */
const CUTOFF_RECOVERY_MESSAGE =
  'Your previous response ended unexpectedly before you finished. ' +
  'Continue directly from where you left off — no apology, no recap. ' +
  'If you were about to call a tool, emit it now.';

/**
 * Creates a promise that resolves after the specified delay, but can be
 * resolved early by calling the returned `skip` function.
 *
 * If an `AbortSignal` is provided and it fires before the delay completes,
 * the promise rejects so the caller's `await` throws and normal error
 * propagation takes over (e.g. the retry loop breaks and the generator exits).
 */
function delay(
  delayMs: number,
  signal?: AbortSignal,
): {
  promise: Promise<void>;
  skip: () => void;
} {
  let resolveRef: () => void;
  let timeoutId: ReturnType<typeof setTimeout>;

  const promise = new Promise<void>((resolve, reject) => {
    resolveRef = resolve;

    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    timeoutId = setTimeout(resolve, delayMs);

    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeoutId);
        reject(signal.reason);
      },
      { once: true },
    );
  });

  return {
    promise,
    skip: () => {
      clearTimeout(timeoutId);
      resolveRef();
    },
  };
}

/**
 * Returns true if the response is valid, false otherwise.
 *
 * The DashScope provider may return the last 2 chunks as:
 * 1. A choice(candidate) with finishReason and empty content
 * 2. Empty choices with usage metadata
 * We'll check separately for both of these cases.
 */
function isValidResponse(response: GenerateContentResponse): boolean {
  if (response.usageMetadata) {
    return true;
  }

  if (response.candidates === undefined || response.candidates.length === 0) {
    return false;
  }

  if (response.candidates.some((candidate) => candidate.finishReason)) {
    return true;
  }

  const content = response.candidates[0]?.content;
  return content !== undefined && isValidContent(content);
}

export function isValidNonThoughtTextPart(part: Part): boolean {
  return (
    typeof part.text === 'string' &&
    !part.thought &&
    !part.thoughtSignature &&
    // Technically, the model should never generate parts that have text and
    //  any of these but we don't trust them so check anyways.
    !part.functionCall &&
    !part.functionResponse &&
    !part.inlineData &&
    !part.fileData
  );
}

function isValidContent(content: Content): boolean {
  if (content.parts === undefined || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === undefined || Object.keys(part).length === 0) {
      return false;
    }
    if (!isValidContentPart(part)) {
      return false;
    }
  }
  return true;
}

function isValidContentPart(part: Part): boolean {
  const isInvalid =
    !part.thought &&
    !part.thoughtSignature &&
    part.text !== undefined &&
    part.text === '' &&
    part.functionCall === undefined;

  return !isInvalid;
}

/**
 * Validates the history contains the correct roles.
 *
 * @throws Error if the history does not start with a user turn.
 * @throws Error if the history contains an invalid role.
 */
function validateHistory(history: Content[]) {
  for (const content of history) {
    if (content.role !== 'user' && content.role !== 'model') {
      throw new Error(`Role must be user or model, but got ${content.role}.`);
    }
  }
}

/**
 * Extracts the curated (valid) history from a comprehensive history.
 *
 * @remarks
 * The model may sometimes generate invalid or empty contents(e.g., due to safety
 * filters or recitation). Extracting valid turns from the history
 * ensures that subsequent requests could be accepted by the model.
 */
function extractCuratedHistory(comprehensiveHistory: Content[]): Content[] {
  if (comprehensiveHistory === undefined || comprehensiveHistory.length === 0) {
    return [];
  }
  const curatedHistory: Content[] = [];
  const length = comprehensiveHistory.length;
  let i = 0;
  while (i < length) {
    if (comprehensiveHistory[i].role === 'user') {
      curatedHistory.push(comprehensiveHistory[i]);
      i++;
    } else {
      const modelOutput: Content[] = [];
      let isValid = true;
      while (i < length && comprehensiveHistory[i].role === 'model') {
        modelOutput.push(comprehensiveHistory[i]);
        if (isValid && !isValidContent(comprehensiveHistory[i])) {
          isValid = false;
        }
        i++;
      }
      if (isValid) {
        curatedHistory.push(...modelOutput);
      }
    }
  }
  return curatedHistory;
}

/**
 * Custom error to signal that a stream completed with invalid content,
 * which should trigger a retry.
 *
 * Three subtypes distinguish the failure mode for diagnostics and retry
 * strategy selection (e.g. non-streaming fallback for OpenAI providers):
 *
 * - `EMPTY_STREAM`: zero chunks received from the provider. Typically a
 *   backend issue (auth/quota/filter) rather than a transport glitch.
 * - `NO_FINISH_REASON`: chunks arrived but the stream closed without a
 *   finishReason AND without usable content. Suggests mid-stream cut-off.
 * - `NO_RESPONSE_TEXT`: finishReason arrived but there is no usable
 *   content — model explicitly finished with nothing useful.
 */
export type InvalidStreamErrorType =
  | 'NO_FINISH_REASON'
  | 'NO_RESPONSE_TEXT'
  | 'EMPTY_STREAM';

export class InvalidStreamError extends Error {
  readonly type: InvalidStreamErrorType;

  constructor(message: string, type: InvalidStreamErrorType) {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}

/**
 * Chat session that enables sending messages to the model with previous
 * conversation context.
 *
 * @remarks
 * The session maintains all the turns between user and model.
 */
export class GeminiChat {
  // A promise to represent the current state of the message being sent to the
  // model.
  private sendPromise: Promise<void> = Promise.resolve();

  /**
   * Set by `processStreamResponse` when a stream ended without a finishReason
   * and without a tool call, but text content had already been delivered —
   * i.e. the model was cut off mid-response. Consumed by `sendMessageStream`
   * to decide whether to trigger multi-turn recovery (auto-continue).
   *
   * Reset to false at the start of every stream so stale cut-off flags from
   * a prior turn never leak into the next one.
   */
  private lastTurnCutOff = false;

  /**
   * Creates a new GeminiChat instance.
   *
   * @param config - The configuration object.
   * @param generationConfig - Optional generation configuration.
   * @param history - Optional initial conversation history.
   * @param chatRecordingService - Optional recording service. If provided, chat
   *   messages will be recorded.
   * @param telemetryService - Optional UI telemetry service. When provided,
   *   prompt token counts are reported on each API response. Pass `undefined`
   *   for sub-agent chats to avoid overwriting the main agent's context usage.
   */
  constructor(
    private readonly config: Config,
    private readonly generationConfig: GenerateContentConfig = {},
    private history: Content[] = [],
    private readonly chatRecordingService?: ChatRecordingService,
    private readonly telemetryService?: UiTelemetryService,
  ) {
    validateHistory(history);
  }

  setSystemInstruction(sysInstr: string) {
    this.generationConfig.systemInstruction = sysInstr;
  }

  /**
   * Sends a message to the model and returns the response in chunks.
   *
   * @remarks
   * This method will wait for the previous message to be processed before
   * sending the next message.
   *
   * @see {@link Chat#sendMessage} for non-streaming method.
   * @param params - parameters for sending the message.
   * @return The model's response.
   *
   * @example
   * ```ts
   * const chat = ai.chats.create({model: 'gemini-2.0-flash'});
   * const response = await chat.sendMessageStream({
   * message: 'Why is the sky blue?'
   * });
   * for await (const chunk of response) {
   * console.log(chunk.text);
   * }
   * ```
   */
  async sendMessageStream(
    model: string,
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<StreamEvent>> {
    await this.sendPromise;

    let streamDoneResolver: () => void;
    const streamDonePromise = new Promise<void>((resolve) => {
      streamDoneResolver = resolve;
    });
    this.sendPromise = streamDonePromise;

    const userContent = createUserContent(params.message);

    // Add user content to history ONCE before any attempts.
    this.history.push(userContent);
    const requestContents = this.getHistory(true);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return (async function* () {
      try {
        let lastError: unknown = new Error('Request failed after all retries.');
        let rateLimitRetryCount = 0;
        let invalidStreamRetryCount = 0;

        // Read per-config overrides; fall back to built-in defaults.
        const cgConfig = self.config.getContentGeneratorConfig();
        const maxRateLimitRetries =
          cgConfig?.maxRetries ?? RATE_LIMIT_RETRY_OPTIONS.maxRetries;
        const extraRetryErrorCodes = cgConfig?.retryErrorCodes;

        // Max output tokens escalation: when no user/env override is set,
        // the capped default (8K) is used. If the model hits MAX_TOKENS,
        // retry once with escalated limit (64K).
        let maxTokensEscalated = false;
        const hasUserMaxTokensOverride =
          (cgConfig?.samplingParams?.max_tokens !== undefined &&
            cgConfig?.samplingParams?.max_tokens !== null) ||
          !!process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];

        let lastFinishReason: string | undefined;

        for (
          let attempt = 0;
          attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts;
          attempt++
        ) {
          try {
            if (
              attempt > 0 ||
              rateLimitRetryCount > 0 ||
              invalidStreamRetryCount > 0
            ) {
              yield { type: StreamEventType.RETRY };
            }

            const stream = await self.makeApiCallAndProcessStream(
              model,
              requestContents,
              params,
              prompt_id,
            );

            lastFinishReason = undefined;
            for await (const chunk of stream) {
              const fr = chunk.candidates?.[0]?.finishReason;
              if (fr) lastFinishReason = fr;
              yield { type: StreamEventType.CHUNK, value: chunk };
            }

            lastError = null;
            break;
          } catch (error) {
            lastError = error;

            // Handle rate-limit / throttling errors returned as stream content.
            // These arrive as StreamContentError with finish_reason="error_finish"
            // from the pipeline, containing the throttling message in the content.
            // Covers TPM throttling, GLM rate limits, and other provider throttling.
            const isRateLimit = isRateLimitError(error, extraRetryErrorCodes);
            if (isRateLimit && rateLimitRetryCount < maxRateLimitRetries) {
              rateLimitRetryCount++;
              const delayMs = RATE_LIMIT_RETRY_OPTIONS.delayMs;
              const message = parseAndFormatApiError(
                error instanceof Error ? error.message : String(error),
              );
              debugLogger.warn(
                `Rate limit throttling detected (retry ${rateLimitRetryCount}/${maxRateLimitRetries}). ` +
                  `Waiting ${delayMs / 1000}s before retrying...`,
              );
              const { promise: delayPromise, skip } = delay(
                delayMs,
                params.config?.abortSignal,
              );
              yield {
                type: StreamEventType.RETRY,
                retryInfo: {
                  message,
                  attempt: rateLimitRetryCount,
                  maxRetries: maxRateLimitRetries,
                  delayMs,
                  skipDelay: skip,
                },
              };
              // Don't count rate-limit retries against the content retry limit
              attempt--;
              await delayPromise;
              continue;
            }

            // Transient stream anomalies (NO_FINISH_REASON / NO_RESPONSE_TEXT):
            // independent retry budget, similar to rate-limit handling.
            // Does NOT consume the content retry budget.
            const isTransientStreamError = error instanceof InvalidStreamError;
            if (
              isTransientStreamError &&
              invalidStreamRetryCount < INVALID_STREAM_RETRY_CONFIG.maxRetries
            ) {
              invalidStreamRetryCount++;
              const delayMs =
                INVALID_STREAM_RETRY_CONFIG.initialDelayMs *
                invalidStreamRetryCount;
              debugLogger.warn(
                `Invalid stream [${(error as InvalidStreamError).type}] ` +
                  `(retry ${invalidStreamRetryCount}/${INVALID_STREAM_RETRY_CONFIG.maxRetries}). ` +
                  `Waiting ${delayMs / 1000}s before retrying...`,
              );
              logContentRetry(
                self.config,
                new ContentRetryEvent(
                  invalidStreamRetryCount - 1,
                  (error as InvalidStreamError).type,
                  delayMs,
                  model,
                ),
              );
              yield { type: StreamEventType.RETRY };
              // Don't count transient retries against content retry limit.
              attempt--;
              await delay(delayMs, params.config?.abortSignal).promise;
              continue;
            }
            // Transient budget exhausted — stop immediately.
            if (isTransientStreamError) {
              if (
                self.shouldAttemptNonStreamingFallback(
                  error as InvalidStreamError,
                )
              ) {
                const totalStreamAttempts = invalidStreamRetryCount + 1;
                debugLogger.warn(
                  `Invalid stream [${(error as InvalidStreamError).type}] persisted after ` +
                    `${totalStreamAttempts} streaming attempts for OpenAI-compatible provider. ` +
                    'Attempting non-streaming fallback.',
                );
                logContentRetry(
                  self.config,
                  new ContentRetryEvent(
                    totalStreamAttempts,
                    'NON_STREAM_FALLBACK',
                    0,
                    model,
                  ),
                );
                try {
                  const fallbackStream =
                    await self.makeApiCallAndProcessNonStream(
                      model,
                      requestContents,
                      params,
                      prompt_id,
                    );

                  for await (const chunk of fallbackStream) {
                    yield { type: StreamEventType.CHUNK, value: chunk };
                  }

                  lastError = null;
                  break;
                } catch (fallbackError) {
                  debugLogger.error(
                    'Non-streaming fallback also failed.',
                    fallbackError,
                  );
                  lastError = fallbackError;
                }
              }
              break;
            }

            // Other content validation errors (e.g. NO_FINISH_REASON).
            const isContentError = error instanceof InvalidStreamError;
            if (isContentError) {
              if (attempt < INVALID_CONTENT_RETRY_OPTIONS.maxAttempts - 1) {
                logContentRetry(
                  self.config,
                  new ContentRetryEvent(
                    attempt,
                    (error as InvalidStreamError).type,
                    INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs,
                    model,
                  ),
                );
                await delay(
                  INVALID_CONTENT_RETRY_OPTIONS.initialDelayMs * (attempt + 1),
                  params.config?.abortSignal,
                ).promise;
                continue;
              }
            }
            break;
          }
        }

        // Max output tokens escalation: if the retry loop succeeded with
        // the capped default (8K) but hit MAX_TOKENS, retry once at 64K.
        // Placed outside the retry loop so that any errors from the
        // escalated stream propagate directly (not caught by retry logic).
        if (
          lastError === null &&
          lastFinishReason === FinishReason.MAX_TOKENS &&
          !maxTokensEscalated &&
          !hasUserMaxTokensOverride
        ) {
          maxTokensEscalated = true;
          debugLogger.info(
            `Output truncated at capped default. Escalating to ${ESCALATED_MAX_TOKENS} tokens.`,
          );
          // Remove partial model response from history
          // (processStreamResponse already pushed it)
          if (
            self.history.length > 0 &&
            self.history[self.history.length - 1].role === 'model'
          ) {
            self.history.pop();
          }
          // Signal UI to discard partial output
          yield { type: StreamEventType.RETRY };
          // Retry with escalated max_tokens
          const escalatedParams: SendMessageParameters = {
            ...params,
            config: {
              ...params.config,
              maxOutputTokens: ESCALATED_MAX_TOKENS,
            },
          };
          const escalatedStream = await self.makeApiCallAndProcessStream(
            model,
            requestContents,
            escalatedParams,
            prompt_id,
          );
          for await (const chunk of escalatedStream) {
            yield { type: StreamEventType.CHUNK, value: chunk };
          }
        }

        // ---------------------------------------------------------------
        // Mid-stream cut-off recovery (auto-continue).
        //
        // Triggered when processStreamResponse set `lastTurnCutOff` —
        // i.e. a stream closed without a finishReason and without a tool
        // call, but text content was already delivered. The most likely
        // cause is an upstream gateway idle timeout that severed the SSE
        // mid-response (see prod session ca35fb55 — "让我更新合并方案：")
        // before the model could emit its planned tool call.
        //
        // We keep the partial in history and inject a CUTOFF_RECOVERY_MESSAGE
        // user turn so the model continues from where it left off, up to
        // MAX_OUTPUT_RECOVERY_ATTEMPTS rounds. Trigger condition is purely
        // structural — no content pattern matching.
        // ---------------------------------------------------------------
        if (lastError === null && self.lastTurnCutOff) {
          let cutOffRecoveryCount = 0;
          let cutOffFinishReason: string | undefined;
          let stillCutOff = true;
          while (
            stillCutOff &&
            cutOffRecoveryCount < MAX_OUTPUT_RECOVERY_ATTEMPTS
          ) {
            cutOffRecoveryCount++;
            debugLogger.info(
              `Stream cut off mid-response. ` +
                `Recovery attempt ${cutOffRecoveryCount}/${MAX_OUTPUT_RECOVERY_ATTEMPTS}.`,
            );
            self.history.push(
              createUserContent([{ text: CUTOFF_RECOVERY_MESSAGE }]),
            );
            yield { type: StreamEventType.RETRY, isContinuation: true };
            const recoveryContents = self.getHistory(true);
            // Reset before the recovery stream; processStreamResponse will
            // set it again if the stream is also cut.
            self.lastTurnCutOff = false;
            cutOffFinishReason = undefined;
            try {
              const recoveryStream = await self.makeApiCallAndProcessStream(
                model,
                recoveryContents,
                params,
                prompt_id,
              );
              for await (const chunk of recoveryStream) {
                const fr = chunk.candidates?.[0]?.finishReason;
                if (fr) cutOffFinishReason = fr;
                yield { type: StreamEventType.CHUNK, value: chunk };
              }
            } catch (recoveryError) {
              if (
                self.history.length > 0 &&
                self.history[self.history.length - 1].role === 'user'
              ) {
                self.history.pop();
              }
              debugLogger.warn(
                'Cut-off recovery attempt failed; stopping recovery loop.',
                recoveryError,
              );
              break;
            }
            // Continue looping only if the recovery stream was also cut
            // off the same way. A real finishReason, a tool call, or any
            // other terminal condition exits the loop.
            stillCutOff =
              self.lastTurnCutOff && cutOffFinishReason === undefined;
          }
        }

        if (lastError) {
          if (lastError instanceof InvalidStreamError) {
            const totalAttempts = invalidStreamRetryCount + 1;
            logContentRetryFailure(
              self.config,
              new ContentRetryFailureEvent(
                totalAttempts,
                lastError.type,
                model,
              ),
            );
          }
          throw lastError;
        }
      } finally {
        streamDoneResolver!();
      }
    })();
  }

  private async makeApiCallAndProcessStream(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const request = this.buildGenerateContentRequest(
      model,
      requestContents,
      params,
    );
    const apiCall = () =>
      this.config
        .getContentGenerator()
        .generateContentStream(request, prompt_id);
    const streamResponse = await retryWithBackoff(apiCall, {
      shouldRetryOnError: (error: unknown) => {
        if (error instanceof Error) {
          if (isSchemaDepthError(error.message)) return false;
          if (isInvalidArgumentError(error.message)) return false;
        }

        const status = getErrorStatus(error);
        if (status === 400) return false;
        if (status === 429) return true;
        if (status && status >= 500 && status < 600) return true;

        return false;
      },
      authType: this.config.getContentGeneratorConfig()?.authType,
    });

    return this.processStreamResponse(model, streamResponse);
  }

  private async makeApiCallAndProcessNonStream(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
    prompt_id: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const request = this.buildGenerateContentRequest(
      model,
      requestContents,
      params,
    );
    const response = await retryWithBackoff(
      () =>
        this.config.getContentGenerator().generateContent(request, prompt_id),
      {
        shouldRetryOnError: (error: unknown) => {
          if (error instanceof Error) {
            if (isSchemaDepthError(error.message)) return false;
            if (isInvalidArgumentError(error.message)) return false;
          }

          const status = getErrorStatus(error);
          if (status === 400) return false;
          if (status === 429) return true;
          if (status && status >= 500 && status < 600) return true;

          return false;
        },
        authType: this.config.getContentGeneratorConfig()?.authType,
      },
    );

    return this.processStreamResponse(
      model,
      (async function* () {
        yield response;
      })(),
    );
  }

  private buildGenerateContentRequest(
    model: string,
    requestContents: Content[],
    params: SendMessageParameters,
  ): GenerateContentParameters {
    return {
      model,
      contents: requestContents,
      config: { ...this.generationConfig, ...params.config },
    };
  }

  private shouldAttemptNonStreamingFallback(
    error: InvalidStreamError,
  ): boolean {
    // Non-streaming fallback is useful when the streaming path is broken but
    // the completion API may still work (e.g. gateway mis-buffering an SSE
    // stream). Applies to both mid-stream cut-offs (NO_FINISH_REASON) and
    // truly empty streams (EMPTY_STREAM) — at worst it fails identically, at
    // best it recovers the turn without a user-visible error.
    return (
      this.config.getContentGeneratorConfig()?.authType ===
        AuthType.USE_OPENAI &&
      (error.type === 'NO_FINISH_REASON' || error.type === 'EMPTY_STREAM')
    );
  }

  /**
   * Returns the chat history.
   *
   * @remarks
   * The history is a list of contents alternating between user and model.
   *
   * There are two types of history:
   * - The `curated history` contains only the valid turns between user and
   * model, which will be included in the subsequent requests sent to the model.
   * - The `comprehensive history` contains all turns, including invalid or
   * empty model outputs, providing a complete record of the history.
   *
   * The history is updated after receiving the response from the model,
   * for streaming response, it means receiving the last chunk of the response.
   *
   * The `comprehensive history` is returned by default. To get the `curated
   * history`, set the `curated` parameter to `true`.
   *
   * @param curated - whether to return the curated history or the comprehensive
   * history.
   * @return History contents alternating between user and model for the entire
   * chat session.
   */
  getHistory(curated: boolean = false): Content[] {
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    // Deep copy the history to avoid mutating the history outside of the
    // chat session.
    return structuredClone(history);
  }

  /**
   * Clears the chat history.
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Adds a new entry to the chat history.
   */
  addHistory(content: Content): void {
    this.history.push(content);
  }

  setHistory(history: Content[]): void {
    this.history = history;
  }

  stripThoughtsFromHistory(): void {
    this.history = this.history
      .map((content) => {
        if (!content.parts) return content;

        // Filter out thought parts entirely
        const filteredParts = content.parts
          .filter(
            (part) =>
              !(
                part &&
                typeof part === 'object' &&
                'thought' in part &&
                part.thought
              ),
          )
          .map((part) => {
            if (
              part &&
              typeof part === 'object' &&
              'thoughtSignature' in part
            ) {
              const newPart = { ...part };
              delete (newPart as { thoughtSignature?: string })
                .thoughtSignature;
              return newPart;
            }
            return part;
          });

        return {
          ...content,
          parts: filteredParts,
        };
      })
      // Remove Content objects that have no parts left after filtering
      .filter((content) => content.parts && content.parts.length > 0);
  }

  /**
   * Strip thought parts from history, keeping the most recent `keepTurns`
   * model turns that contain thinking blocks intact.
   *
   * Selection is based on thought-containing turns specifically (not all
   * model turns) so the most recent reasoning chain is always preserved
   * even if later model turns happen to have no thinking.
   *
   * Used for idle cleanup: after exceeding the configured idle threshold
   * the old thinking blocks are no longer useful for reasoning coherence
   * but still consume context tokens.
   */
  stripThoughtsFromHistoryKeepRecent(keepTurns: number): void {
    keepTurns = Number.isFinite(keepTurns)
      ? Math.max(0, Math.floor(keepTurns))
      : 0;

    // Find indices of model turns that contain thought parts
    const modelTurnIndices: number[] = [];
    for (let i = 0; i < this.history.length; i++) {
      const content = this.history[i];
      if (
        content.role === 'model' &&
        content.parts?.some(
          (part) =>
            part &&
            typeof part === 'object' &&
            'thought' in part &&
            part.thought,
        )
      ) {
        modelTurnIndices.push(i);
      }
    }

    // Determine which model turns to keep (the most recent `keepTurns`)
    const turnsToStrip = new Set(
      modelTurnIndices.slice(
        0,
        Math.max(0, modelTurnIndices.length - keepTurns),
      ),
    );

    if (turnsToStrip.size === 0) return;

    this.history = this.history
      .map((content, index) => {
        if (!turnsToStrip.has(index) || !content.parts) return content;

        // Strip thought parts from this turn
        const filteredParts = content.parts
          .filter(
            (part) =>
              !(
                part &&
                typeof part === 'object' &&
                'thought' in part &&
                part.thought
              ),
          )
          .map((part) => {
            if (
              part &&
              typeof part === 'object' &&
              'thoughtSignature' in part
            ) {
              const newPart = { ...part };
              delete (newPart as { thoughtSignature?: string })
                .thoughtSignature;
              return newPart;
            }
            return part;
          });

        return {
          ...content,
          parts: filteredParts,
        };
      })
      // Remove Content objects that have no parts left after filtering
      .filter((content) => content.parts && content.parts.length > 0);
  }

  /**
   * Pop all orphaned trailing user entries from chat history.
   * In a valid conversation the last entry is always a model response;
   * any trailing user entries are leftovers from a request that failed.
   */
  stripOrphanedUserEntriesFromHistory(): void {
    while (
      this.history.length > 0 &&
      this.history[this.history.length - 1]!.role === 'user'
    ) {
      this.history.pop();
    }
  }

  setTools(tools: Tool[]): void {
    this.generationConfig.tools = tools;
  }

  /** Returns a shallow copy of the current generation config (for cache param snapshots). */
  getGenerationConfig(): GenerateContentConfig {
    return { ...this.generationConfig };
  }

  async maybeIncludeSchemaDepthContext(error: StructuredError): Promise<void> {
    // Check for potentially problematic cyclic tools with cyclic schemas
    // and include a recommendation to remove potentially problematic tools.
    if (
      isSchemaDepthError(error.message) ||
      isInvalidArgumentError(error.message)
    ) {
      const toolRegistry = this.config.getToolRegistry();
      await toolRegistry.warmAll();
      const tools = toolRegistry.getAllTools();
      const cyclicSchemaTools: string[] = [];
      for (const tool of tools) {
        if (
          (tool.schema.parametersJsonSchema &&
            hasCycleInSchema(tool.schema.parametersJsonSchema)) ||
          (tool.schema.parameters && hasCycleInSchema(tool.schema.parameters))
        ) {
          cyclicSchemaTools.push(tool.displayName);
        }
      }
      if (cyclicSchemaTools.length > 0) {
        const extraDetails =
          `\n\nThis error was probably caused by cyclic schema references in one of the following tools, try disabling them with excludeTools:\n\n - ` +
          cyclicSchemaTools.join(`\n - `) +
          `\n`;
        error.message += extraDetails;
      }
    }
  }

  private async *processStreamResponse(
    model: string,
    streamResponse: AsyncGenerator<GenerateContentResponse>,
  ): AsyncGenerator<GenerateContentResponse> {
    // Collect ALL parts from the model response (including thoughts for recording)
    const allModelParts: Part[] = [];
    let usageMetadata: GenerateContentResponseUsageMetadata | undefined;

    let hasToolCall = false;
    let hasFinishReason = false;
    let chunkCount = 0;
    // Clear any cut-off flag left behind by a previous turn. Set later in
    // this method if the stream ends with text but no finishReason / tool
    // call.
    this.lastTurnCutOff = false;

    for await (const chunk of streamResponse) {
      chunkCount++;
      // Use ||= to avoid later usage-only chunks (no candidates) overwriting
      // a finishReason that was already seen in an earlier chunk.
      hasFinishReason ||=
        chunk?.candidates?.some((candidate) => candidate.finishReason) ?? false;

      if (isValidResponse(chunk)) {
        const content = chunk.candidates?.[0]?.content;
        if (content?.parts) {
          if (content.parts.some((part) => part.functionCall)) {
            hasToolCall = true;
          }

          // Collect all parts for recording
          allModelParts.push(...content.parts);
        }
      }

      // Collect token usage for consolidated recording
      if (chunk.usageMetadata) {
        usageMetadata = chunk.usageMetadata;
        // Use || instead of ?? so that totalTokenCount=0 falls back to promptTokenCount.
        // Some providers omit total_tokens or return 0 in streaming usage chunks.
        const lastPromptTokenCount =
          usageMetadata.totalTokenCount || usageMetadata.promptTokenCount;
        if (lastPromptTokenCount && this.telemetryService) {
          this.telemetryService.setLastPromptTokenCount(lastPromptTokenCount);
        }
        if (usageMetadata.cachedContentTokenCount && this.telemetryService) {
          this.telemetryService.setLastCachedContentTokenCount(
            usageMetadata.cachedContentTokenCount,
          );
        }
      }

      yield chunk; // Yield every chunk to the UI immediately.
    }

    let thoughtContentPart: Part | undefined;
    const thoughtText = allModelParts
      .filter((part) => part.thought)
      .map((part) => part.text)
      .join('')
      .trim();

    if (thoughtText !== '') {
      thoughtContentPart = {
        text: thoughtText,
        thought: true,
      };

      const thoughtSignature = allModelParts.filter(
        (part) => part.thoughtSignature && part.thought,
      )?.[0]?.thoughtSignature;
      if (thoughtContentPart && thoughtSignature) {
        thoughtContentPart.thoughtSignature = thoughtSignature;
      }
    }

    const contentParts = allModelParts.filter((part) => !part.thought);
    const consolidatedHistoryParts: Part[] = [];
    for (const part of contentParts) {
      const lastPart =
        consolidatedHistoryParts[consolidatedHistoryParts.length - 1];
      if (
        lastPart?.text &&
        isValidNonThoughtTextPart(lastPart) &&
        isValidNonThoughtTextPart(part)
      ) {
        lastPart.text += part.text;
      } else if (isValidContentPart(part)) {
        consolidatedHistoryParts.push(part);
      }
    }

    const contentText = consolidatedHistoryParts
      .filter((part) => part.text)
      .map((part) => part.text)
      .join('')
      .trim();

    // Record assistant turn with raw Content and metadata
    if (thoughtContentPart || contentText || hasToolCall || usageMetadata) {
      const contextWindowSize =
        this.config.getContentGeneratorConfig()?.contextWindowSize;
      this.chatRecordingService?.recordAssistantTurn({
        model,
        message: [
          ...(thoughtContentPart ? [thoughtContentPart] : []),
          ...(contentText ? [{ text: contentText }] : []),
          ...(hasToolCall
            ? contentParts
                .filter((part) => part.functionCall)
                .map((part) => ({ functionCall: part.functionCall }))
            : []),
        ],
        tokens: usageMetadata,
        contextWindowSize,
      });
    }

    // ---------------------------------------------------------------------------
    // Stream validation
    // ---------------------------------------------------------------------------
    //
    // Providers occasionally violate the streaming protocol contract. Observed
    // failure modes, all surfaced as plain SSE closure with HTTP 200:
    //   - EMPTY_STREAM:       no semantic chunks delivered to this validator.
    //                         Typically a backend issue (auth/quota/content-
    //                         filter), but could also be a provider stream made
    //                         entirely of keepalives / filtered-empty chunks.
    //                         Seen in prod session bb9759c4 on glm-5.
    //   - NO_FINISH_REASON:   some chunks arrived but the stream closed without
    //                         a finishReason AND without usable content. Rare;
    //                         worth retrying as a transient glitch.
    //   - NO_RESPONSE_TEXT:   finishReason arrived but content is empty.
    //   - CUT-OFF (no error): chunks arrived, text was streamed, but no
    //                         finishReason AND no tool call. Gateway idle
    //                         timeout or mid-stream network cut-off. The
    //                         partial is preserved in history and the
    //                         `lastTurnCutOff` flag is set so the outer
    //                         sendMessageStream loop can trigger multi-turn
    //                         recovery (auto-continue). See session
    //                         ca35fb55.
    // ---------------------------------------------------------------------------
    const hasAnyContent = contentText || thoughtText;
    if (!hasToolCall) {
      if (chunkCount === 0) {
        // No semantic chunks reached this validator — distinct from
        // NO_FINISH_REASON so diagnostics and UX can hint at provider-side
        // root causes without over-claiming what happened on the wire.
        throw new InvalidStreamError(
          'Model returned no usable stream content. ' +
            'This typically indicates a backend issue — check provider ' +
            'auth, quota, content filter, or stream gateway behavior.',
          'EMPTY_STREAM',
        );
      }
      if (!hasFinishReason && !hasAnyContent) {
        // Chunks came through but the stream closed without a finish signal
        // or any usable content.
        throw new InvalidStreamError(
          'Model stream ended without a finish reason.',
          'NO_FINISH_REASON',
        );
      } else if (hasFinishReason && !hasAnyContent) {
        // Model sent a finish signal but produced zero usable content.
        throw new InvalidStreamError(
          'Model stream ended with empty response text.',
          'NO_RESPONSE_TEXT',
        );
      } else if (!hasFinishReason && contentText) {
        // Stream cut off mid-response but text was already delivered. Do NOT
        // silently accept as a final turn — the model may have been about to
        // emit a tool call when the connection was cut (e.g. DataWorks
        // gateway idle timeout at ~60s while the model was still thinking).
        // Keep the partial in history and set a flag so sendMessageStream can
        // trigger the recovery loop (auto-continue). This replaces the old
        // `e0841ec0b` silent-accept fallback with a structural signal that
        // doesn't require content pattern matching.
        debugLogger.warn(
          'Stream ended without a finish reason but has text ' +
            `(${contentText.length} chars text, ${thoughtText.length} chars thought). ` +
            'Flagging for multi-turn recovery (auto-continue).',
        );
        this.lastTurnCutOff = true;
      }
      // Note: thought-only + no finish is accepted as-is (no recovery). Thinking
      // models legitimately emit only thought parts before being cut; continuing
      // on a thought-only turn risks the model thrashing with no visible output.
    }

    this.history.push({
      role: 'model',
      parts: [
        ...(thoughtContentPart ? [thoughtContentPart] : []),
        ...consolidatedHistoryParts,
      ],
    });
  }
}

/** Visible for Testing */
export function isSchemaDepthError(errorMessage: string): boolean {
  return errorMessage.includes('maximum schema depth exceeded');
}

export function isInvalidArgumentError(errorMessage: string): boolean {
  return errorMessage.includes('Request contains an invalid argument');
}
