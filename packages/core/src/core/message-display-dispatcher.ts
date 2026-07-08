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
 * Owns the delivery side of the MessageDisplay hook for ONE streamed message:
 * mints the `message_id`, folds streamed chunks through the pure
 * {@link stepMessageDisplay} debounce, and dispatches due flushes through
 * MessageBus without ever blocking the streaming loop that feeds it.
 *
 * Delivery is coalescing, not queueing: at most one hook request is in flight
 * at a time, and at most one payload is held pending behind it. A newer flush
 * simply overwrites the pending payload — lossless, because `displayed_text`
 * is cumulative, so the newest payload strictly supersedes any older one.
 * This bounds a slow hook's backlog to O(1) instead of letting undelivered
 * batches accumulate for the length of the stream, and it means `is_final`
 * is delivered at most one hook-execution behind the message actually ending.
 *
 * {@link finish} is idempotent and resolves only once every enqueued payload
 * has actually been delivered (or failed), so callers can await it before
 * ending the turn — without that, a short-lived process (headless `-p`) can
 * exit while the final payload is still queued and silently drop it.
 */
export class MessageDisplayDispatcher {
  readonly messageId: string = randomUUID();

  private state: MessageDisplayState;
  private pending: { displayedText: string; isFinal: boolean } | null = null;
  private inFlight: Promise<void> | null = null;
  private finished = false;
  private drainWaiters: Array<() => void> = [];

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
      this.enqueue(step.flush.displayedText, false);
    }
  }

  /**
   * Close out this message: enqueue the `is_final: true` flush (skipped when
   * no text ever streamed — a tool-call-only message — or when the turn was
   * aborted, matching the Stop hook's cancellation guard), then wait for
   * every enqueued payload to drain. Idempotent — extra calls just await the
   * drain, so it is safe to call from both an explicit exit site and a
   * `finally` block. The final flush intentionally re-sends the same
   * cumulative text as the last debounced flush when nothing changed since
   * then: `is_final` is itself new information (it tells subscribers this
   * message is done), so the event still fires even when the text didn't.
   */
  async finish(): Promise<void> {
    if (!this.finished) {
      this.finished = true;
      if (this.state.displayedText !== '' && !this.signal.aborted) {
        this.enqueue(this.state.displayedText, true);
      }
    }
    if (this.signal.aborted) {
      // A cancelled turn never fires is_final (matching the Stop hook being
      // skipped on abort) and shouldn't hold the turn's teardown hostage to a
      // still-running hook process either — leave any in-flight mid-stream
      // delivery to settle in the background.
      return;
    }
    await this.drained();
  }

  /**
   * Overwrite the single pending slot with the newest payload and kick the
   * pump. `is_final` is sticky: once a final payload is pending it stays
   * final even if (defensively) a non-final enqueue were to land after it.
   */
  private enqueue(displayedText: string, isFinal: boolean): void {
    this.pending = {
      displayedText,
      isFinal: isFinal || (this.pending?.isFinal ?? false),
    };
    this.pump();
  }

  private pump(): void {
    if (this.inFlight || !this.pending) {
      return;
    }
    const payload = this.pending;
    this.pending = null;
    this.inFlight = this.messageBus
      .request<HookExecutionRequest, HookExecutionResponse>(
        {
          type: MessageBusType.HOOK_EXECUTION_REQUEST,
          eventName: 'MessageDisplay',
          input: {
            message_id: this.messageId,
            displayed_text: payload.displayedText,
            is_final: payload.isFinal,
          },
          signal: this.signal,
        },
        MessageBusType.HOOK_EXECUTION_RESPONSE,
      )
      .then(() => undefined)
      .catch((err) => {
        this.warn(`MessageDisplay hook failed [${this.messageId}]: ${err}`);
      })
      .finally(() => {
        this.inFlight = null;
        if (this.pending) {
          this.pump();
        } else {
          for (const resolve of this.drainWaiters.splice(0)) {
            resolve();
          }
        }
      });
  }

  /** Resolves once nothing is in flight and nothing is pending. */
  private drained(): Promise<void> {
    if (!this.inFlight && !this.pending) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }
}
