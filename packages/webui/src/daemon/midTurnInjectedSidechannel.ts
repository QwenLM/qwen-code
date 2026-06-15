/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonMidTurnMessageInjectedData } from '@qwen-code/sdk/daemon';

/**
 * Side channel for `mid_turn_message_injected` daemon events. Mirrors
 * {@link ./followupSidechannel.ts}: the session event pump parses the raw
 * frame and publishes here, and a consumer (`useDaemonMidTurnInjected`) reads
 * the latest batch via `useSyncExternalStore`. Kept out of the transcript
 * reducer because it is a transient UX signal — the consumer moves the matching
 * messages out of its own pending queue (so they are not resent as the next
 * turn) rather than rendering anything from it.
 */

const listeners = new Set<() => void>();
let lastInjected: DaemonMidTurnMessageInjectedData | undefined;

export function getSidechannelMidTurnInjected():
  | DaemonMidTurnMessageInjectedData
  | undefined {
  return lastInjected;
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
  // Fresh object every publish so `useSyncExternalStore` sees a new snapshot
  // and re-fires consumers even when two batches carry identical text.
  lastInjected = { ...data, messages: [...data.messages] };
  notifyMidTurnInjectedListeners();
}

export function clearSidechannelMidTurnInjected(): void {
  if (lastInjected === undefined) return;
  lastInjected = undefined;
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
  return { sessionId, messages: stringMessages };
}
