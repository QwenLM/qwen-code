/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  MessageBusType,
  type HookExecutionRequest,
  type HookExecutionResponse,
} from '../confirmation-bus/types.js';
import {
  createInitialMessageDisplayState,
  stepMessageDisplay,
  MESSAGE_DISPLAY_DEBOUNCE_MS,
  type MessageDisplayState,
} from './message-display-buffer.js';

/**
 * Ceiling on how long {@link MessageDisplayDispatcher.finish} waits for the
 * final payload's delivery to complete before letting the turn's teardown
 * proceed anyway. Well short of `DEFAULT_HOOK_TIMEOUT` (60s, hookRunner.ts)
 * because a slow or hung MessageDisplay hook shouldn't be able to freeze
 * `qwen -p` or an ACP stream loop's `finally` for anywhere near that long.
 * The budget is shared across finish() calls (client.ts calls it from an
 * explicit exit site and again from a finally), so this constant is the
 * ceiling itself, not a per-call increment. The hook has already received
 * the `is_final` payload by the time this wait starts — the timeout only
 * bounds how long the caller waits for the hook to finish executing, and
 * delivery keeps running in the background past it.
 */
export const MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS = 5000;

/**
 * Owns the delivery side of the MessageDisplay hook for ONE streamed message:
 * mints the `message_id`, folds streamed chunks through the pure
 * {@link stepMessageDisplay} debounce, and dispatches due flushes through
 * MessageBus without ever blocking the streaming loop that feeds it.
 *
 * Mid-stream delivery is coalescing, not queueing: at most one hook request
 * is in flight at a time, and at most one payload is held pending behind it.
 * A newer flush simply overwrites the pending payload — lossless, because
 * `displayed_text` is cumulative, so the newest payload strictly supersedes
 * any older one. This bounds a slow hook's backlog to O(1) instead of letting
 * undelivered batches accumulate for the length of the stream.
 *
 * The final payload is the one exception to the single-request rule:
 * {@link finish} dispatches it immediately, alongside any still-running
 * mid-stream delivery, rather than queueing behind it. The same supersession
 * argument applies one slot further — an in-flight mid-stream payload carries
 * strictly less information than the final one, so waiting for it to settle
 * would only delay `is_final` by a full hook execution, and in a short-lived
 * process (headless `-p`) could drop it entirely when the process exits with
 * the final payload still queued. A hook may therefore see its last
 * mid-stream execution overlap the final one.
 *
 * {@link finish} is idempotent and resolves once the final payload's
 * delivery has completed, or after {@link MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS}
 * — whichever comes first — so callers can await it before ending the turn
 * without a hung hook holding the turn hostage.
 */
export class MessageDisplayDispatcher {
  readonly messageId: string = randomUUID();

  private state: MessageDisplayState;
  /** Newest undelivered mid-stream text, coalesced behind {@link inFlight}. */
  private pending: string | null = null;
  /** The one in-flight mid-stream delivery (single-request rule). */
  private inFlight: Promise<void> | null = null;
  /** The final payload's delivery, dispatched by {@link finish}. */
  private finalDelivery: Promise<void> | null = null;
  private finished = false;
  /**
   * The one bounded wait on {@link finalDelivery}, shared by every finish()
   * call — a single timeout budget, no matter how many times (or how
   * concurrently) finish() is invoked.
   */
  private drain: Promise<void> | null = null;

  /**
   * @param warn Additional sink for delivery warnings — typically the
   *   surface's debug-file logger. The dispatcher always mirrors warnings to
   *   `console.warn` itself, so callers don't need (and shouldn't add) their
   *   own console wiring: a warning here means a documented delivery
   *   guarantee is at stake, which must be visible by default even when no
   *   debug-log session is active.
   */
  constructor(
    private readonly messageBus: MessageBus,
    private readonly signal: AbortSignal,
    private readonly warn: (message: string) => void,
    nowMs: number = Date.now(),
  ) {
    this.state = createInitialMessageDisplayState(nowMs);
  }

  /**
   * Fold one streamed text chunk into the accumulator, firing a debounced
   * mid-stream flush if one is due. Never blocks: dispatch happens in the
   * background, and the caller's streaming loop continues immediately.
   */
  addChunk(chunk: string, nowMs: number = Date.now()): void {
    if (this.finished) {
      return;
    }
    const step = stepMessageDisplay(
      this.state,
      chunk,
      nowMs,
      MESSAGE_DISPLAY_DEBOUNCE_MS,
      false,
    );
    this.state = step.next;
    if (step.flush) {
      this.pending = step.flush.displayedText;
      this.pump();
    }
  }

  /**
   * Close out this message: dispatch the `is_final: true` payload (skipped
   * when no text ever streamed — a tool-call-only message — or when the turn
   * was aborted, matching the Stop hook's cancellation guard), then wait for
   * its delivery to complete, bounded by the shared drain budget. Idempotent
   * — extra calls just re-await the (already spent or already settled)
   * drain, so it is safe to call from both an explicit exit site and a
   * `finally` block without doubling the ceiling. The final flush
   * intentionally re-sends the same cumulative text as the last debounced
   * flush when nothing changed since then: `is_final` is itself new
   * information (it tells subscribers this message is done), so the event
   * still fires even when the text didn't.
   */
  async finish(): Promise<void> {
    if (!this.finished) {
      this.finished = true;
      if (this.state.displayedText !== '' && !this.signal.aborted) {
        // The final payload strictly supersedes any queued or in-flight
        // mid-stream delivery (displayed_text is cumulative), so it never
        // waits behind one: drop the pending payload and dispatch is_final
        // NOW, alongside the stale delivery if one is still running. This
        // is what keeps is_final's dispatch prompt — and ordered before the
        // Stop hook — even when the hook is slower than the drain budget:
        // the budget below bounds how long we wait for the hook to finish
        // executing, not whether it receives the payload.
        this.pending = null;
        this.finalDelivery = this.dispatch(this.state.displayedText, true);
      }
    }
    if (this.signal.aborted) {
      // A cancelled turn never fires is_final (matching the Stop hook being
      // skipped on abort) and shouldn't hold the turn's teardown hostage to a
      // still-running hook process either — leave any in-flight mid-stream
      // delivery to settle in the background.
      return;
    }
    await this.drainWithTimeout();
  }

  /** Send one payload through MessageBus; failures are logged, never thrown. */
  private dispatch(displayedText: string, isFinal: boolean): Promise<void> {
    return this.messageBus
      .request<HookExecutionRequest, HookExecutionResponse>(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'MessageDisplay',
          input: {
            message_id: this.messageId,
            displayed_text: displayedText,
            is_final: isFinal,
          },
          signal: this.signal,
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      )
      .then(() => undefined)
      .catch((err) => {
        if (this.finished && !isFinal) {
          // This delivery was superseded by the final payload before it
          // settled; its outcome no longer matters, so a late failure (e.g.
          // the bus request's own timeout) must not alarm anyone about a
          // turn that completed correctly.
          return;
        }
        this.emitWarning(
          `MessageDisplay hook failed [${this.messageId}]: ${err}`,
        );
      });
  }

  /**
   * Route a warning to the console AND the injected sink. The sink is
   * typically a gated debug-file logger (a no-op without an active debug-log
   * session), and these warnings fire exactly when a documented delivery
   * guarantee is at stake — they must reach stderr by default on every
   * surface (headless, ACP — stdout carries the protocol, stderr is free —
   * and the TUI, where ink's patchConsole renders them above the app).
   */
  private emitWarning(message: string): void {
    // eslint-disable-next-line no-console
    console.warn(message);
    this.warn(message);
  }

  private pump(): void {
    if (this.inFlight || this.pending === null) {
      return;
    }
    const displayedText = this.pending;
    this.pending = null;
    this.inFlight = this.dispatch(displayedText, false).finally(() => {
      this.inFlight = null;
      this.pump();
    });
  }

  /**
   * Resolves once the final payload's delivery has settled, or after
   * {@link MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS} elapses — whichever comes
   * first. A superseded mid-stream delivery still running in the background
   * never holds the drain; only the final payload's own delivery does. The
   * wait is memoized: every finish() call — sequential or concurrent —
   * shares the same single promise and timer, so the ceiling is the constant
   * itself, never a multiple of it, and a call after the delivery settled
   * costs nothing.
   */
  private drainWithTimeout(): Promise<void> {
    const delivery = this.finalDelivery;
    if (!delivery) {
      return Promise.resolve();
    }
    this.drain ??= new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.emitWarning(
          `MessageDisplay hook [${this.messageId}] still running after ` +
            `${MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS}ms; continuing without ` +
            'waiting for it to finish (the hook already received the final ' +
            'payload; its execution continues in the background).',
        );
        resolve();
      }, MESSAGE_DISPLAY_DRAIN_TIMEOUT_MS);
      timer.unref?.();
      void delivery.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.drain;
  }
}
