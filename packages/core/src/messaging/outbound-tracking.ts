/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * When this process may send to a peer again.
 *
 * Two sessions that each answer every message keep a conversation going with
 * nobody asking for it. A send to one peer is refused once
 * {@link MAX_PEER_SENDS_WITHOUT_HUMAN} sends to it have gone out with no human
 * message in between; the user's next message resets every count.
 *
 * Keyed on the peer's `uds:` address, which is what both an inbound `from` and
 * a resolved recipient carry. Process-scoped: a resumed conversation starts
 * with an empty map.
 */

/** Sends to one peer allowed between two human messages. */
export const MAX_PEER_SENDS_WITHOUT_HUMAN = 3;

const sendsSinceHuman = new Map<string, number>();

/** A human message reached the model: every peer's count starts over. */
export function noteHumanTurn(): void {
  sendsSinceHuman.clear();
}

/** Whether another send to `address` stays within the reply-loop limit. */
export function peerSendAllowed(address: string): boolean {
  return (sendsSinceHuman.get(address) ?? 0) < MAX_PEER_SENDS_WITHOUT_HUMAN;
}

/** Counts a send that went out. Failed sends do not count. */
export function notePeerSend(address: string): void {
  sendsSinceHuman.set(address, (sendsSinceHuman.get(address) ?? 0) + 1);
}

export function _resetOutboundTrackingForTest(): void {
  sendsSinceHuman.clear();
}
