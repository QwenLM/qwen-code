/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildUserFrame,
  describeHoldCause,
  type HeldMessage,
} from '@qwen-code/qwen-code-core';
import {
  buildPeerReviewRequest,
  heldSenderLabel,
  MAX_PEER_REVIEW_TEXT_CHARS,
  PEER_DELIVER_OPTION_ID,
  PEER_DROP_OPTION_ID,
  PEER_MESSAGE_INTERACTION_KIND,
  PEER_REVIEW_REQUEST_TTL_MS,
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
      title: 'Cross-session message from build bot: please rebase onto main',
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

  it("bounds a never-expiring hold's request, keeping the hold's truth in the details", () => {
    // ACP gives no way to withdraw a sent request: without a deadline the
    // daemon would keep it pending forever, past the hold itself ending.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const request = buildPeerReviewRequest('session-1', {
        entry: held(),
        expiresAt: null,
      });
      const expiresAt = 1_000_000 + PEER_REVIEW_REQUEST_TTL_MS;
      expect(request._meta).toEqual({
        qwenInteractionKind: PEER_MESSAGE_INTERACTION_KIND,
        expiresAt,
      });
      expect(request.toolCall._meta).toMatchObject({ expiresAt });
      // The details still say the hold itself never expires.
      expect(
        (request.toolCall.rawInput as { expiresAt: number | null }).expiresAt,
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('names the message in the title, so two holds from one sender differ', () => {
    const first = buildPeerReviewRequest('s', {
      entry: held(),
      expiresAt: null,
    });
    const second = buildPeerReviewRequest('s', {
      entry: held({
        frame: buildUserFrame({
          content: 'deploy the release',
          from: '/tmp/peer.sock',
          fromName: 'build bot',
        }),
      }),
      expiresAt: null,
    });
    expect(first.toolCall.title).not.toBe(second.toolCall.title);
    expect(second.toolCall.title).toBe(
      'Cross-session message from build bot: deploy the release',
    );
  });

  it('keeps the title one bounded printable line whatever the body holds', () => {
    const request = buildPeerReviewRequest('s', {
      entry: held({
        frame: buildUserFrame({
          content: `\u001b[2Jfirst line\nsecond line\n${'x'.repeat(500)}`,
          from: '/tmp/peer.sock',
        }),
      }),
      expiresAt: null,
    });
    const title = request.toolCall.title ?? '';
    const control = [...title].some((ch) => {
      const point = ch.codePointAt(0) ?? 0;
      return point < 0x20 || (point >= 0x7f && point <= 0x9f);
    });
    expect(control).toBe(false);
    expect(Array.from(title).length).toBeLessThanOrEqual(
      'Cross-session message from /tmp/peer.sock: '.length + 120,
    );
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

  it('flattens the peer-chosen from and fromName to bounded one-line labels', () => {
    const entry = held({
      frame: buildUserFrame({
        content: 'x',
        from: `\u001b[2J${'a'.repeat(5_000)}`,
        fromName: 'line one\nline two',
      }),
    });
    const details = peerReviewDetails({ entry, expiresAt: null });
    expect(details.from).not.toContain('\u001b');
    expect(Array.from(details.from!).length).toBe(200);
    expect(details.from!.endsWith('\u2026')).toBe(true);
    expect(details.fromName).toBe('line one line two');
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

  it('tells a re-attributed or re-caused hold apart from its stale review', () => {
    const entry = held();
    // A controller grant revoked while the message waits: the outstanding
    // review still shows controller provenance, so it must be re-asked.
    const withController: HeldMessage = {
      ...entry,
      controller: { id: 'c_0123abcd', label: 'voice bridge' },
    };
    expect(peerReviewKey(withController)).not.toBe(peerReviewKey(entry));
    // Re-judged under a new cause or scope: the review's cause text no
    // longer matches what is held.
    expect(peerReviewKey({ ...entry, cause: 'mode-unknown' })).not.toBe(
      peerReviewKey(entry),
    );
    expect(peerReviewKey({ ...entry, policyScope: 'workspace' })).not.toBe(
      peerReviewKey(entry),
    );
    expect(peerReviewKey({ ...entry, selfSent: true })).not.toBe(
      peerReviewKey(entry),
    );
  });
});

describe('heldSenderLabel', () => {
  it('falls back to a readable sender when the frame gives nothing', () => {
    // The wire parser passes a present-but-empty `from` through.
    expect(
      heldSenderLabel(
        held({ frame: buildUserFrame({ content: 'x', from: '' }) }),
      ),
    ).toBe('unknown session');
    expect(
      heldSenderLabel(
        held({
          frame: buildUserFrame({ content: 'x', from: ' ', fromName: ' ' }),
        }),
      ),
    ).toBe('unknown session');
    // A self-sent frame with no address names what it is, matching the
    // fallback the delivered path shows.
    expect(
      heldSenderLabel(
        held({ frame: buildUserFrame({ content: 'x' }), selfSent: true }),
      ),
    ).toBe('own process');
    // A controller keeps its user-given label however blank `from` is.
    expect(
      heldSenderLabel(
        held({
          frame: buildUserFrame({ content: 'x', from: '' }),
          controller: { id: 'c_0123abcd', label: 'voice bridge' },
        }),
      ),
    ).toBe('voice bridge');
  });
});
