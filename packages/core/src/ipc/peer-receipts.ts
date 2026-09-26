/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PeerControlFrame, PeerDeliveryStatus } from './peer-frames.js';

export const MAX_TRACKED_PEER_MESSAGES = 256;
export const PEER_RECEIPT_TTL_MS = 60 * 60 * 1000;

interface TrackedMessage {
  sentAt: number;
  lastStatus?: PeerDeliveryStatus;
}

const tracked = new Map<string, TrackedMessage>();

function sweep(now: number): void {
  for (const [msgId, entry] of tracked) {
    if (
      entry.lastStatus !== 'held' &&
      now - entry.sentAt > PEER_RECEIPT_TTL_MS
    ) {
      tracked.delete(msgId);
    }
  }
}

export function trackSentPeerMessage(
  msgId: string,
  now: number = Date.now(),
): void {
  sweep(now);
  tracked.delete(msgId);
  tracked.set(msgId, { sentAt: now });
  while (tracked.size > MAX_TRACKED_PEER_MESSAGES) {
    const oldest = tracked.keys().next().value;
    if (oldest === undefined) break;
    tracked.delete(oldest);
  }
}

export function forgetSentPeerMessage(msgId: string): void {
  tracked.delete(msgId);
}

export function acceptPeerDeliveryStatus(
  frame: PeerControlFrame,
  now: number = Date.now(),
): boolean {
  sweep(now);
  const entry = tracked.get(frame.origMsgId);
  if (!entry || entry.lastStatus === frame.status) return false;
  if (frame.status === 'held') {
    entry.lastStatus = frame.status;
  } else {
    tracked.delete(frame.origMsgId);
  }
  return true;
}
