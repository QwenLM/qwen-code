/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildUserFrame,
  describeHoldCause,
  type HeldMessage,
} from '@qwen-code/qwen-code-core';
import {
  buildPeerReviewRequest,
  MAX_PEER_REVIEW_TEXT_CHARS,
  PEER_DELIVER_OPTION_ID,
  PEER_DROP_OPTION_ID,
  PEER_MESSAGE_INTERACTION_KIND,
  peerReviewDecision,
  peerReviewDetails,
  peerReviewKey,
} from './peer-inbound.js';

function held(over: Partial<HeldMessage> = {}): HeldMessage {
  return {
    frame: buildUserFrame({
      content: 'please rebase onto main',
      from: '/tmp/peer.sock',
      fromName: 'build bot',
      fromMode: 'bypass',
      toSessionId: 'session-1',
    }),
    cause: 'mode-mismatch',
    heldAt: 1_000,
    ...over,
  };
}

describe('buildPeerReviewRequest', () => {
  it('asks about the message as a permission request with two options', () => {
    const entry = held();
    const request = buildPeerReviewRequest('session-1', {
      entry,
      expiresAt: 61_000,
    });

    expect(request.sessionId).toBe('session-1');
    expect(request.toolCall).toMatchObject({
      toolCallId: `peer-message:${entry.frame.msgId}`,
      title: 'Cross-session message: build bot',
      kind: 'other',
      status: 'pending',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'please rebase onto main' },
        },
      ],
    });
    expect(request.options).toEqual([
      {
        optionId: PEER_DELIVER_OPTION_ID,
        name: 'Deliver to this session',
        kind: 'allow_once',
      },
      { optionId: PEER_DROP_OPTION_ID, name: 'Drop', kind: 'reject_once' },
    ]);
    expect(request._meta).toEqual({
      qwenInteractionKind: PEER_MESSAGE_INTERACTION_KIND,
      expiresAt: 61_000,
    });
    const details = peerReviewDetails({ entry, expiresAt: 61_000 });
    expect(request.toolCall.rawInput).toEqual(details);
    expect(request.toolCall._meta).toEqual({
      qwenInteractionKind: PEER_MESSAGE_INTERACTION_KIND,
      peerMessage: details,
      expiresAt: 61_000,
    });
  });

  it('leaves out the expiry when the hold never expires', () => {
    const request = buildPeerReviewRequest('session-1', {
      entry: held(),
      expiresAt: null,
    });
    expect(request._meta).toEqual({
      qwenInteractionKind: PEER_MESSAGE_INTERACTION_KIND,
    });
    expect(request.toolCall._meta).not.toHaveProperty('expiresAt');
  });

  it('bounds the body a dialog has to lay out', () => {
    const entry = held({
      frame: buildUserFrame({
        content: 'x'.repeat(MAX_PEER_REVIEW_TEXT_CHARS + 50),
        from: '/tmp/peer.sock',
      }),
    });
    const request = buildPeerReviewRequest('s', { entry, expiresAt: null });
    const block = request.toolCall.content?.[0];
    const text =
      block?.type === 'content' && block.content.type === 'text'
        ? block.content.text
        : '';
    expect(Array.from(text)).toHaveLength(MAX_PEER_REVIEW_TEXT_CHARS);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('peerReviewDetails', () => {
  it('says where the message came from and why it waits', () => {
    const entry = held({ policyScope: 'workspace', cause: 'explicit-setting' });
    expect(peerReviewDetails({ entry, expiresAt: null })).toEqual({
      msgId: entry.frame.msgId,
      sender: 'build bot',
      from: '/tmp/peer.sock',
      fromName: 'build bot',
      origin: 'peer',
      cause: 'explicit-setting',
      causeText: describeHoldCause('explicit-setting', 'workspace'),
      heldAt: 1_000,
      expiresAt: null,
    });
  });

  it('names a controller by its grant and marks own-process messages', () => {
    const controller = { id: 'c_0123abcd', label: 'voice bridge' };
    expect(
      peerReviewDetails({ entry: held({ controller }), expiresAt: null }),
    ).toMatchObject({
      sender: 'voice bridge',
      origin: 'controller',
      controller: 'voice bridge',
    });
    expect(
      peerReviewDetails({ entry: held({ selfSent: true }), expiresAt: null })
        .origin,
    ).toBe('own-process');
  });
});

describe('peerReviewDecision', () => {
  it('maps the two options and treats anything else as no answer', () => {
    const selected = (optionId: string) => ({
      outcome: { outcome: 'selected' as const, optionId },
    });
    expect(peerReviewDecision(selected(PEER_DELIVER_OPTION_ID))).toBe(
      'deliver',
    );
    expect(peerReviewDecision(selected(PEER_DROP_OPTION_ID))).toBe('drop');
    expect(peerReviewDecision(selected('proceed_once'))).toBe('cancelled');
    expect(peerReviewDecision({ outcome: { outcome: 'cancelled' } })).toBe(
      'cancelled',
    );
  });
});

describe('peerReviewKey', () => {
  it('tells a re-held message from its earlier hold', () => {
    const entry = held();
    expect(peerReviewKey(entry)).toBe(peerReviewKey({ ...entry }));
    expect(peerReviewKey(entry)).not.toBe(
      peerReviewKey({ ...entry, heldAt: entry.heldAt + 1 }),
    );
  });
});
