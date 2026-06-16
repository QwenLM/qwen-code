/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonMidTurnMessageInjectedData } from '@qwen-code/sdk/daemon';

/**
 * Side channel for `mid_turn_message_injected` daemon events. Patterned on
 * {@link ./followupSidechannel.ts}, but ACCUMULATING rather than latest-wins:
 * the session event pump parses each raw frame and publishes here, appending to
 * a buffer that a consumer (`useDaemonMidTurnInjected`) drains via
 * `useSyncExternalStore` and then clears. Kept out of the transcript reducer
 * because it is a transient UX signal — the consumer moves the matching messages
 * out of its own pending queue (so they are not resent as the next turn) rather
 * than rendering anything from it. (Followup can be latest-wins because only the
 * newest suggestion matters; mid-turn drains are cumulative — every batch must
 * be reconciled or its messages get double-delivered.)
 */

const listeners = new Set<() => void>();
// Accumulating buffer — NOT latest-wins. A turn can drain in more than one
// tool batch, so the daemon publishes one frame per non-empty drain, and the
// event pump delivers buffered frames back-to-back with no await between them.
// Two frames can therefore land before the consumer's effect runs; a single-
// slot store would drop the first, and its messages would never be removed from
// the browser's pending queue (⇒ resent next turn = the double delivery this
// feature prevents). Every batch is retained until the consumer reconciles it
// and calls `clearSidechannelMidTurnInjected`. `EMPTY` is a shared frozen ref so
// the empty snapshot is reference-stable for `useSyncExternalStore`.
const EMPTY: readonly DaemonMidTurnMessageInjectedData[] = Object.freeze([]);
// Safety cap so an orphaned buffer (consumer unmounted or session switched
// without ever consuming) can't grow without bound. Past the cap the OLDEST
// batch is evicted: under that much un-reconciled backlog the consumer is gone,
// so there is no pending queue left to double-deliver into.
const MAX_PENDING_BATCHES = 64;
let pending: readonly DaemonMidTurnMessageInjectedData[] = EMPTY;

export function getSidechannelMidTurnInjected(): readonly DaemonMidTurnMessageInjectedData[] {
  return pending;
}

export function subscribeSidechannelMidTurnInjected(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishSidechannelMidTurnInjected(
  data: DaemonMidTurnMessageInjectedData,
): void {
  // Append (new array ref so `useSyncExternalStore` re-fires). Copy the batch so
  // a later mutation of the source can't change what the consumer reconciles.
  const appended = [
    ...pending,
    {
      sessionId: data.sessionId,
      messages: [...data.messages],
      ...(data.originatorClientId
        ? { originatorClientId: data.originatorClientId }
        : {}),
    },
  ];
  pending =
    appended.length > MAX_PENDING_BATCHES
      ? appended.slice(appended.length - MAX_PENDING_BATCHES)
      : appended;
  notifyMidTurnInjectedListeners();
}

/**
 * Clear the buffer. Pass `expected` (the exact snapshot the consumer just
 * reconciled) for a compare-and-swap clear: `useDaemonMidTurnInjected` reads
 * `pending` during render and reconciles it in an async effect, so a new frame
 * can append in the window between the read and the effect. Clearing
 * unconditionally would wipe that newly-arrived batch before it is reconciled —
 * its messages stay in the browser's pending queue and are resent next turn (the
 * double delivery this feature exists to prevent). When a frame arrived,
 * `pending !== expected`, so we no-op and leave it for the next reconcile.
 * Omitting `expected` clears unconditionally (e.g. test teardown).
 */
export function clearSidechannelMidTurnInjected(
  expected?: readonly DaemonMidTurnMessageInjectedData[],
): void {
  if (expected !== undefined && pending !== expected) return;
  if (pending.length === 0) return;
  pending = EMPTY;
  notifyMidTurnInjectedListeners();
}

function notifyMidTurnInjectedListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Parse a raw daemon SSE frame into the injected-messages payload, or
 * `undefined` if the frame is not a well-formed `mid_turn_message_injected`
 * event. Filters out non-string / empty entries; returns `undefined` when
 * nothing usable remains.
 */
export function parseSidechannelMidTurnInjected(
  event: unknown,
): DaemonMidTurnMessageInjectedData | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  if (record['type'] !== 'mid_turn_message_injected') return undefined;
  const data = record['data'];
  if (!data || typeof data !== 'object') return undefined;
  const dataRecord = data as Record<string, unknown>;
  const sessionId = dataRecord['sessionId'];
  const messages = dataRecord['messages'];
  if (typeof sessionId !== 'string' || !Array.isArray(messages)) {
    return undefined;
  }
  const stringMessages = messages.filter(
    (message): message is string =>
      typeof message === 'string' && message.length > 0,
  );
  if (stringMessages.length === 0) return undefined;
  // `originatorClientId` lives on the SSE envelope (top-level), not in `data` —
  // the daemon publishes one frame per originator so consumers dedupe only
  // their own queue.
  const originatorClientId = record['originatorClientId'];
  return {
    sessionId,
    messages: stringMessages,
    ...(typeof originatorClientId === 'string' ? { originatorClientId } : {}),
  };
}
