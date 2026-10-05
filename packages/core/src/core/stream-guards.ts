/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stream-safety guards shared by every streaming wire (OpenAI pipeline and
 * Anthropic generator). Both wires face the same hazards once a streaming
 * response has returned 200 — a stream that goes silent, and a drip-fed
 * stream that never completes (issue #8597) — so the watchdog mechanics and
 * their tuning knobs live here once instead of drifting per wire (issue
 * #9005 finding 4). The SDK `timeout` only bounds connect + first response,
 * which is why these guards exist at all.
 */

import type { ContentGeneratorConfig } from './contentGenerator.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  MAX_STREAM_GUARD_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV,
} from './openaiContentGenerator/constants.js';

/**
 * Thrown when a streaming response goes silent past the inactivity timeout.
 * `code: 'ETIMEDOUT'` makes `classifyRetryError` treat it as a retryable
 * transport error, identical to a real socket read timeout.
 */
export class StreamInactivityTimeoutError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(
    readonly idleMs: number,
    readonly chunksReceived: number,
    readonly streamLifetimeMs: number,
  ) {
    super(
      `No stream activity for ${idleMs}ms after ${chunksReceived} chunks ` +
        `(stream lifetime: ${streamLifetimeMs}ms). For provider-backed models, ` +
        `increase modelProviders[providerId][].generationConfig.streamIdleTimeoutMs; ` +
        `provider configuration takes precedence, so model.generationConfig is ` +
        `ignored for those models. For runtime models, increase ` +
        `model.generationConfig.streamIdleTimeoutMs. Built-in Qwen OAuth models ` +
        `cannot be overridden via settings. Use ${QWEN_STREAM_IDLE_TIMEOUT_MS_ENV} ` +
        `for them or whenever no explicit value is active. ` +
        `Set the active value to 0 to disable it.`,
    );
    this.name = 'StreamInactivityTimeoutError';
  }
}

/**
 * Thrown when a streaming response exceeds its upstream-wait budget without
 * completing. The cap charges accumulated time blocked in `await it.next()`
 * (upstream latency), never the consumer's processing, so a buffered,
 * already-complete stream never trips it — the shape it catches is a
 * never-completing stream the inactivity watchdog cannot see: a drip-fed
 * gateway or a model crawling through an oversized response resets that
 * watchdog forever (issue #8597). Same retryable `ETIMEDOUT` code, so a
 * text-only generation resumes via the transport-continuation recovery; a
 * turn that already streamed a functionCall surfaces as a visible,
 * classified error instead.
 */
export class StreamLifetimeExceededError extends Error {
  readonly code = 'ETIMEDOUT' as const;

  constructor(
    readonly maxLifetimeMs: number,
    readonly chunksReceived: number,
    readonly streamLifetimeMs: number,
  ) {
    super(
      `Stream exceeded its ${maxLifetimeMs}ms upstream-wait cap after ` +
        `${chunksReceived} chunks without completing (wall clock: ` +
        `${streamLifetimeMs}ms). Set ` +
        `${QWEN_STREAM_MAX_LIFETIME_MS_ENV} to increase this cap ` +
        `(or 0 to disable it).`,
    );
    this.name = 'StreamLifetimeExceededError';
  }
}

/**
 * Resolve a stream-guard timeout (ms). Precedence, for both guards: explicit
 * `ContentGeneratorConfig` field (programmatic, wins — including `0` to
 * disable) > the env deployment knob > the built-in default. A malformed env
 * value is ignored (with a `console.warn`) rather than failing the request.
 */
function resolveStreamGuardMs(
  fromConfig: number | undefined,
  configLabel: string,
  envName: string,
  defaultMs: number,
): number {
  // 1. Explicit config field (programmatic) wins:
  //    - `<= 0` disables the watchdog (downstream `> 0` guards skip it).
  //    - Values above the JS timer ceiling are rejected: setTimeout silently
  //      compresses them to 1ms, which would fire near-immediately.
  //    - NaN/Infinity/non-integer are invalid.
  if (typeof fromConfig === 'number') {
    if (
      Number.isInteger(fromConfig) &&
      fromConfig <= MAX_STREAM_GUARD_TIMEOUT_MS
    ) {
      return fromConfig;
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring out-of-range ${configLabel}=${fromConfig} ` +
        `(expected an integer in (-∞, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); ` +
        `falling back to ${envName}/default.`,
    );
  }
  // 2. Env deployment knob. Strict decimal integer only — reject hex/scientific
  //    notation/floats/signs so a typo can't silently become a surprising
  //    timeout. `0` disables; values above the timer ceiling are rejected.
  const raw = process.env[envName];
  const trimmed = raw?.trim();
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (parsed <= MAX_STREAM_GUARD_TIMEOUT_MS) {
        return parsed;
      }
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring invalid ${envName}="${raw}" ` +
        `(expected an integer of milliseconds in [0, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); ` +
        `using default ${defaultMs}ms.`,
    );
  }
  return defaultMs;
}

export function resolveStreamIdleTimeoutMs(
  config: ContentGeneratorConfig,
): number {
  return resolveStreamGuardMs(
    config.streamIdleTimeoutMs,
    'streamIdleTimeoutMs',
    QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  );
}

export function resolveStreamMaxLifetimeMs(
  config: ContentGeneratorConfig,
): number {
  return resolveStreamGuardMs(
    config.streamMaxLifetimeMs,
    'streamMaxLifetimeMs',
    QWEN_STREAM_MAX_LIFETIME_MS_ENV,
    DEFAULT_STREAM_MAX_LIFETIME_MS,
  );
}

/**
 * Wraps a streaming chunk source with two guards. The inactivity watchdog: if
 * no chunk arrives for `idleMs`, `abortRequest()` is invoked (to abort the
 * underlying request and free the socket) and the iterator throws — a user
 * `AbortError` when the parent signal was cancelled, otherwise a retryable
 * ETIMEDOUT. The idle timer resets on every chunk (including
 * thinking/reasoning deltas), so an actively streaming model is never
 * interrupted by it. The lifetime cap does NOT reset: once the stream has
 * accumulated `maxLifetimeMs` of upstream-wait time (the time spent blocked
 * on the source, never the consumer's time after a yield) without
 * completing, the iterator throws the same way — the bound a drip-fed
 * stream cannot reset (issue #8597). `<= 0` disables each guard
 * independently.
 */
export async function* withStreamGuards<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  maxLifetimeMs: number,
  abortRequest: () => void,
  parentSignal: AbortSignal | undefined,
): AsyncGenerator<T> {
  // Both guards off: pass the source through untouched. The caller's
  // `idleMs > 0 || maxLifetimeMs > 0` already prevents this, but the invariant
  // must live here too — with both `<= 0`, `wait` computes to `Infinity` and
  // Node clamps `setTimeout(Infinity)` to ~1ms, so every stream would die
  // instantly with a bogus lifetime error.
  if (idleMs <= 0 && maxLifetimeMs <= 0) {
    yield* source;
    return;
  }
  const it = source[Symbol.asyncIterator]();
  // Monotonic, never `Date.now()`: an NTP step must not kill a healthy
  // generation on the next iteration (a forward jump) nor silently disable
  // the cap until the clock catches up (a backward jump) — the hang this
  // guard exists to bound. The setTimeout this races is a monotonic clock
  // too, so the two agree.
  const streamStartedAt = performance.now();
  // The lifetime cap is on ACCUMULATED UPSTREAM-WAIT — the wall-clock time
  // this loop spends blocked in `await it.next()`. It is deliberately NOT
  // end-to-end delivery time: an upstream that finished and buffered its
  // chunks owes nothing, however slowly the consumer drains (a paused IDE
  // client, a big TUI render), and a stream whose terminal `done` resolves
  // at the boundary completes rather than becoming a retry. The cap only
  // bites while the consumer is actually waiting on the model — which is
  // exactly where #8597's drip-fed, never-completing stream spends its time.
  let upstreamMs = 0;
  let chunksReceived = 0;
  try {
    while (true) {
      const remainingMs =
        maxLifetimeMs > 0
          ? maxLifetimeMs - upstreamMs
          : Number.POSITIVE_INFINITY;
      // The upstream-wait budget is already spent; a further wait can only
      // lose, so fail it here (the lifetime timer below normally wins first).
      if (remainingMs <= 0) {
        // Same precedence as the timer below: a user cancellation wins over
        // the cap's retryable ETIMEDOUT.
        if (parentSignal?.aborted) {
          const abortErr = new Error('Aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        abortRequest();
        throw new StreamLifetimeExceededError(
          maxLifetimeMs,
          chunksReceived,
          performance.now() - streamStartedAt,
        );
      }
      const nextPromise = it.next();
      const awaitedAt = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        // The caller wraps only when at least one guard is positive, so at
        // least one of these is finite.
        const idleIn = idleMs > 0 ? idleMs : Number.POSITIVE_INFINITY;
        const wait = Math.min(idleIn, remainingMs);
        timer = setTimeout(
          () => {
            if (parentSignal?.aborted) {
              // Plain Error (not DOMException) so error redaction's prototype
              // clone cannot corrupt it; name 'AbortError' satisfies isAbortError.
              const abortErr = new Error('Aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            } else if (remainingMs <= idleIn) {
              abortRequest();
              reject(
                new StreamLifetimeExceededError(
                  maxLifetimeMs,
                  chunksReceived,
                  performance.now() - streamStartedAt,
                ),
              );
            } else {
              abortRequest();
              reject(
                new StreamInactivityTimeoutError(
                  idleMs,
                  chunksReceived,
                  performance.now() - streamStartedAt,
                ),
              );
            }
          },
          Math.max(wait, 0),
        );
        timer.unref?.();
      });
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([nextPromise, timeout]);
      } catch (err) {
        // Once abortRequest() aborts the request, the orphaned next() rejects
        // with an AbortError; swallow it so it is not an unhandled rejection.
        void Promise.resolve(nextPromise).catch(() => {});
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (result.done) return;
      // Charge only the time this chunk took to arrive — the upstream
      // latency — never the time the consumer spent after the previous yield.
      upstreamMs += performance.now() - awaitedAt;
      chunksReceived += 1;
      yield result.value;
    }
  } finally {
    abortRequest();
    try {
      await it.return?.();
    } catch {
      // The abort above is the cleanup that matters; ignore return failures.
    }
  }
}
