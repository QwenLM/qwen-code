/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { PeerControlFrame, PeerDeliveryStatus } from './peer-frames.js';
import {
  acceptPeerDeliveryStatus,
  forgetSentPeerMessage,
  MAX_TRACKED_PEER_MESSAGES,
  PEER_RECEIPT_TTL_MS,
  trackSentPeerMessage,
} from './peer-receipts.js';

function receipt(msgId: string, status: PeerDeliveryStatus): PeerControlFrame {
  return {
    msgV: 1,
    msgId: `receipt-${msgId}`,
    type: 'control',
    action: 'delivery_status',
    status,
    origMsgId: msgId,
  };
}

describe('peer receipt tracking', () => {
  it('accepts held followed by a terminal status exactly once', () => {
    trackSentPeerMessage('message-a', 1);

    expect(acceptPeerDeliveryStatus(receipt('message-a', 'held'), 2)).toBe(
      true,
    );
    expect(acceptPeerDeliveryStatus(receipt('message-a', 'held'), 3)).toBe(
      false,
    );
    expect(acceptPeerDeliveryStatus(receipt('message-a', 'delivered'), 4)).toBe(
      true,
    );
    expect(acceptPeerDeliveryStatus(receipt('message-a', 'delivered'), 5)).toBe(
      false,
    );
  });

  it('rejects untracked and expired receipts', () => {
    expect(acceptPeerDeliveryStatus(receipt('never-sent', 'delivered'))).toBe(
      false,
    );
    trackSentPeerMessage('expired', 1);
    expect(
      acceptPeerDeliveryStatus(
        receipt('expired', 'denied'),
        1 + PEER_RECEIPT_TTL_MS + 1,
      ),
    ).toBe(false);
  });

  it('keeps a held message correlated until its terminal receipt', () => {
    trackSentPeerMessage('long-hold', 1);
    expect(acceptPeerDeliveryStatus(receipt('long-hold', 'held'), 2)).toBe(
      true,
    );
    expect(
      acceptPeerDeliveryStatus(
        receipt('long-hold', 'delivered'),
        1 + PEER_RECEIPT_TTL_MS + 1,
      ),
    ).toBe(true);
  });

  it('bounds tracked messages and allows failed sends to be forgotten', () => {
    for (let i = 0; i <= MAX_TRACKED_PEER_MESSAGES; i++) {
      trackSentPeerMessage(`bounded-${i}`, 1);
    }
    expect(acceptPeerDeliveryStatus(receipt('bounded-0', 'delivered'), 2)).toBe(
      false,
    );
    expect(
      acceptPeerDeliveryStatus(
        receipt(`bounded-${MAX_TRACKED_PEER_MESSAGES}`, 'delivered'),
        2,
      ),
    ).toBe(true);

    trackSentPeerMessage('failed', 3);
    forgetSentPeerMessage('failed');
    expect(acceptPeerDeliveryStatus(receipt('failed', 'expired'), 4)).toBe(
      false,
    );
  });
});
