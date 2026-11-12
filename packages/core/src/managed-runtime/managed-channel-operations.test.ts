/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isChannelDeliveryStart,
  isChannelDeliverySuccessor,
  isChannelRouteStart,
  isChannelRouteSuccessor,
  parseChannelDelivery,
  parseChannelRoute,
} from './managed-channel-record.js';
import {
  MANAGED_CHANNEL_LIMITS,
  channelDeliveryCancelRequestedBody,
  channelDeliveryCancelledBody,
  channelDeliveryId,
  channelDeliveryPlanBody,
  channelDeliveryReceiptBody,
  channelDeliveryRejectedBody,
  channelDeliveryResendBody,
  channelResendDeliveryId,
  channelDeliveryResendable,
  channelDeliverySendingBody,
  channelDeliveryUnknownBody,
  channelIngressKey,
  channelInputId,
  channelInputText,
  channelRouteId,
  channelRouteOpenBody,
  channelRouteRolloverBody,
  CHANNEL_CAPACITY_NOTICE,
  CHANNEL_TRUNCATION_NOTICE,
  channelSessionCreationKey,
  decodeChannelInputEnvelope,
  decodeChannelPolicy,
  decodeChannelReply,
  encodeChannelInputEnvelope,
  encodeChannelPolicy,
  encodeChannelReply,
  planChannelSegments,
  truncateChannelTextUtf8,
  type ChannelInputEnvelope,
} from './managed-channel-operations.js';
import { ManagedSessionRecordError } from './managed-session-records.js';

const REPLACEMENT_CHARACTER = '\uFFFD';

function ref(resourceId: string, bytes: string | Buffer, kind = 'k') {
  const buffer = Buffer.from(bytes);
  return {
    resourceId,
    kind,
    schemaVersion: 1,
    byteLength: buffer.byteLength,
    digest: createHash('sha256').update(buffer).digest('hex'),
  };
}

const IDENTITY = {
  tenantId: 'tenant-1',
  channelInstanceId: 'mail-1',
  accountGeneration: 2,
  platformEventId: '1700:42',
  semanticRevision: 1,
};

const SCOPE = {
  kind: 'chat_thread' as const,
  senderId: null,
  chatId: 'alice@example.com',
  threadId: 'thread-1',
};

const POLICY = {
  adapter: 'email',
  senderPolicy: 'allowlist' as const,
  allowedSenders: ['alice@example.com'],
  dispatchMode: 'followup' as const,
};

function envelope(
  overrides: Partial<ChannelInputEnvelope> = {},
): ChannelInputEnvelope {
  return {
    channelInstanceId: 'mail-1',
    accountId: 'agent@example.com',
    accountGeneration: 2,
    platformEventId: '1700:42',
    semanticRevision: 1,
    routeId: 'chrt-x',
    routeRevision: 1,
    senderId: 'alice@example.com',
    chatId: 'alice@example.com',
    threadId: 'thread-1',
    subject: 'Build <status>',
    text: 'Please check the build.',
    attachments: [],
    replyContext: { parent: '<a@b>', references: ['<a@b>'] },
    ...overrides,
  };
}

const POLICY_REF = ref('policy-1', encodeChannelPolicy(POLICY));

function openRoute() {
  return channelRouteOpenBody({
    routeId: channelRouteId({
      channelInstanceId: 'mail-1',
      accountId: 'agent@example.com',
      scope: SCOPE,
    }),
    channelInstanceId: 'mail-1',
    accountId: 'agent@example.com',
    accountGeneration: 2,
    rootSessionId: 'session-1',
    sessionId: 'session-1',
    scope: SCOPE,
    policyRef: POLICY_REF,
  });
}

function plan(segments = 2) {
  return channelDeliveryPlanBody({
    deliveryId: 'd-1',
    routeId: 'chrt-x',
    routeRevision: 1,
    sourceTurnId: 'turn-1',
    contentRef: ref('reply-1', 'reply'),
    segments: Array.from({ length: segments }, (_, index) => ({
      segmentId: `d-1:${index}`,
      contentRef: ref(`seg-${index}`, `part ${index}`),
    })),
  });
}

const RECEIPT = {
  providerMessageId: '<m1@example.com>',
  acceptedAt: 1_750_000_000_000,
  proofRef: null,
};

describe('channel identities', () => {
  it('derives the ingress key exactly like the Java route key', () => {
    const expected = createHash('sha256')
      .update('tenant-1\u0000mail-1\u00002\u00001700:42\u00001', 'utf8')
      .digest('hex');
    expect(channelIngressKey(IDENTITY)).toBe(expected);
    expect(channelInputId(IDENTITY)).toBe(`chin-${expected}`);
  });

  it('separates a redelivery from a second event and a re-keyed account', () => {
    expect(channelInputId({ ...IDENTITY })).toBe(channelInputId(IDENTITY));
    expect(
      channelInputId({ ...IDENTITY, platformEventId: '1700:43' }),
    ).not.toBe(channelInputId(IDENTITY));
    expect(channelInputId({ ...IDENTITY, accountGeneration: 3 })).not.toBe(
      channelInputId(IDENTITY),
    );
    expect(() =>
      channelInputId({ ...IDENTITY, platformEventId: 'a\u0000b' }),
    ).toThrow(ManagedSessionRecordError);
    expect(() => channelInputId({ ...IDENTITY, accountGeneration: 0 })).toThrow(
      ManagedSessionRecordError,
    );
  });

  it('keys the route chain by scope, never by generation', () => {
    const base = {
      channelInstanceId: 'mail-1',
      accountId: 'agent@example.com',
    };
    const routeId = channelRouteId({ ...base, scope: SCOPE });
    expect(routeId).toMatch(/^chrt-[a-f0-9]{64}$/);
    expect(channelRouteId({ ...base, scope: SCOPE })).toBe(routeId);
    expect(
      channelRouteId({ ...base, scope: { ...SCOPE, threadId: 'thread-2' } }),
    ).not.toBe(routeId);
    expect(
      channelRouteId({ ...base, accountId: 'other@example.com', scope: SCOPE }),
    ).not.toBe(routeId);
    expect(
      channelSessionCreationKey({
        tenantId: 'tenant-1',
        channelInstanceId: 'mail-1',
        routeId,
      }),
    ).toMatch(/^chcr-[a-f0-9]{64}$/);
    expect(channelDeliveryId('chin-abc')).toBe('chin-abc:reply');
    expect(channelResendDeliveryId('chin-abc:reply', 2)).toBe(
      'chin-abc:reply:r2',
    );
    expect(() => channelResendDeliveryId('chin-abc:reply', 0)).toThrow(
      ManagedSessionRecordError,
    );
  });
});

describe('channel policy and envelopes', () => {
  it('round-trips a policy and refuses malformed ones', () => {
    expect(decodeChannelPolicy(encodeChannelPolicy(POLICY))).toEqual(POLICY);
    for (const broken of [
      '{"allowed":["x"]}',
      JSON.stringify({ ...POLICY, adapter: 'E mail' }),
      JSON.stringify({ ...POLICY, senderPolicy: 'pairing' }),
      JSON.stringify({ ...POLICY, dispatchMode: 'collect' }),
      JSON.stringify({ ...POLICY, allowedSenders: [''] }),
      'not json',
    ]) {
      expect(() => decodeChannelPolicy(Buffer.from(broken))).toThrow(
        ManagedSessionRecordError,
      );
    }
  });

  it('round-trips an envelope with staged and omitted attachments', () => {
    const staged = {
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      byteLength: 5,
      digest: createHash('sha256').update('hello').digest('hex'),
      ref: ref('att-1', 'hello', 'managed-channel-attachment'),
    };
    const omitted = {
      fileName: 'big.bin',
      mimeType: 'application/octet-stream',
      byteLength: 10 * 1024 * 1024,
      digest: 'a'.repeat(64),
      omitted: 'too_large' as const,
    };
    const bytes = encodeChannelInputEnvelope(
      envelope({ attachments: [staged, omitted] }),
    );
    const decoded = decodeChannelInputEnvelope(bytes);
    expect(decoded.attachments).toEqual([staged, omitted]);
    expect(decoded.replyContext).toEqual({
      parent: '<a@b>',
      references: ['<a@b>'],
    });
    const text = channelInputText(decoded);
    expect(text).toContain(
      '<subject untrusted="true">Build &lt;status&gt;</subject>',
    );
    expect(text).toContain('resource="att-1"');
    expect(text).toContain('omitted="too_large"');
    expect(text).toContain('<text>Please check the build.</text>');
  });

  it('bounds the envelope', () => {
    expect(() =>
      encodeChannelInputEnvelope(
        envelope({ text: 'x'.repeat(MANAGED_CHANNEL_LIMITS.maxTextChars + 1) }),
      ),
    ).toThrow(ManagedSessionRecordError);
    expect(() =>
      encodeChannelInputEnvelope(
        envelope({
          attachments: Array.from(
            { length: MANAGED_CHANNEL_LIMITS.maxAttachments + 1 },
            () => ({
              fileName: 'a',
              mimeType: 'text/plain',
              byteLength: 1,
              digest: 'b'.repeat(64),
              omitted: 'too_large' as const,
            }),
          ),
        }),
      ),
    ).toThrow(/at most 16/);
    expect(() =>
      encodeChannelInputEnvelope(
        envelope({
          replyContext: {
            pad: 'p'.repeat(MANAGED_CHANNEL_LIMITS.maxReplyContextBytes),
          },
        }),
      ),
    ).toThrow(/byte_limit/);
    expect(() =>
      encodeChannelInputEnvelope(
        envelope({
          attachments: [
            {
              fileName: 'a',
              mimeType: 'text/plain',
              byteLength: 5,
              digest: 'c'.repeat(64),
              ref: ref('att-1', 'hello'),
            },
          ],
        }),
      ),
    ).toThrow(/describe the bytes/);
    expect(() =>
      encodeChannelInputEnvelope(
        envelope({ text: 'x'.repeat(MANAGED_CHANNEL_LIMITS.maxTextChars) }),
      ),
    ).not.toThrow();
  });

  it('round-trips a reply and plans ordered segments for a long answer', () => {
    const reply = { text: 'Done.', replyContext: { parent: '<a@b>' } };
    expect(decodeChannelReply(encodeChannelReply(reply))).toEqual(reply);
    expect(planChannelSegments('short')).toEqual(['short']);
    expect(planChannelSegments('')).toEqual(['']);
    // 3-byte code points: three full segments, no notice, no lost tail.
    const long = '€'.repeat(MANAGED_CHANNEL_LIMITS.maxSegmentBytes);
    const pieces = planChannelSegments(long);
    expect(pieces).toHaveLength(3);
    expect(pieces.join('')).toBe(long);
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(
        MANAGED_CHANNEL_LIMITS.maxSegmentBytes,
      );
      expect(piece).not.toContain(CHANNEL_TRUNCATION_NOTICE);
      expect(piece).not.toContain(REPLACEMENT_CHARACTER);
    }
  });

  it('splits a mixed reply on code-point boundaries and concatenates back', () => {
    const text = 'answer 答案 🙂\n'.repeat(8_000);
    const pieces = planChannelSegments(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.length).toBeLessThanOrEqual(
      MANAGED_CHANNEL_LIMITS.maxSegments,
    );
    expect(pieces.join('')).toBe(text);
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(
        MANAGED_CHANNEL_LIMITS.maxSegmentBytes,
      );
      expect(piece).not.toContain(REPLACEMENT_CHARACTER);
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          piece,
        ),
      ).toBe(false);
    }
  });

  it('prefers a line end within the byte budget for segment boundaries', () => {
    const text =
      'x'.repeat(40_000) +
      '\n' +
      'y'.repeat(40_000) +
      '\n' +
      'z'.repeat(20_000);
    const pieces = planChannelSegments(text);
    expect(pieces).toHaveLength(3);
    expect(pieces[0]).toBe('x'.repeat(40_000) + '\n');
    expect(pieces[1]).toBe('y'.repeat(40_000) + '\n');
    expect(pieces[2]).toBe('z'.repeat(20_000));
    expect(pieces.join('')).toBe(text);
  });

  it('keeps the nominal byte capacity when lines are longer than half a segment', () => {
    const maxBytes = MANAGED_CHANNEL_LIMITS.maxSegmentBytes;
    const capacity = maxBytes * MANAGED_CHANNEL_LIMITS.maxSegments;
    // Long lines put each window's last newline far below the byte bound
    // (a 24 KiB line halves every piece). An unconditional line-end cut
    // would exhaust the 64-segment budget at a fraction of the capacity
    // and drop a tail that fits; the cut must fall back to the byte bound
    // whenever the remainder would no longer fit the remaining segments.
    for (const lineBytes of [4_096, 8_192, 16_384, 24_576, 32_768]) {
      const line = 'x'.repeat(lineBytes) + '\n';
      const text = line
        .repeat(Math.ceil(capacity / line.length))
        .slice(0, capacity);
      const pieces = planChannelSegments(text);
      expect(pieces.join('')).toBe(text);
      expect(pieces.length).toBeLessThanOrEqual(
        MANAGED_CHANNEL_LIMITS.maxSegments,
      );
      expect(pieces[pieces.length - 1]!).not.toContain(
        CHANNEL_TRUNCATION_NOTICE,
      );
    }
  });

  it('takes the line-end cut when the remainder fits the remaining segments exactly', () => {
    const maxBytes = MANAGED_CHANNEL_LIMITS.maxSegmentBytes;
    // A 40,001-byte first line then exactly 63 full segments: the bytes after
    // the line-end cut equal the remaining segment budget to the byte, so the
    // <= boundary must admit the cut. A one-byte-stricter guard would fall
    // back to full width and lose the line end.
    const firstLine = 'x'.repeat(40_000) + '\n';
    const text = firstLine + 'y'.repeat(63 * maxBytes);
    const pieces = planChannelSegments(text);
    expect(pieces[0]).toBe(firstLine);
    expect(pieces).toHaveLength(64);
    expect(pieces.join('')).toBe(text);
    expect(pieces[pieces.length - 1]!).not.toContain(CHANNEL_TRUNCATION_NOTICE);
  });

  it('does not cut a lone newline into its own segment at the window start', () => {
    const maxBytes = MANAGED_CHANNEL_LIMITS.maxSegmentBytes;
    // A full segment of y, a newline, then just over a segment of b: the
    // newline lands at the start of the second window. Without the fill
    // floor it is cut alone (a 1-byte segment = its own publish / claim /
    // provider message); the floor absorbs it into a full-width piece.
    const text = 'y'.repeat(maxBytes) + '\n' + 'b'.repeat(maxBytes + 1);
    const pieces = planChannelSegments(text);
    expect(pieces.join('')).toBe(text);
    expect(pieces).toHaveLength(3);
    for (const piece of pieces) {
      expect(piece).not.toBe('\n');
    }
  });

  it('bounds the visible loss when mixed widths sit exactly at the capacity', () => {
    const maxBytes = MANAGED_CHANNEL_LIMITS.maxSegmentBytes;
    const capacity = maxBytes * MANAGED_CHANNEL_LIMITS.maxSegments;
    // A 4-byte emoji aligned so every full-width cut backs off 3 bytes: at
    // exactly the nominal capacity the only loss is the alignment slack plus
    // the notice room, and it stays visible, a strict prefix, never
    // mid-code-point. Uniform-width text never drifts (49152 divides 1..4).
    const unit = '\u{1F642}' + 'x'.repeat(49_145);
    const text =
      unit.repeat(MANAGED_CHANNEL_LIMITS.maxSegments) +
      'x'.repeat(capacity - MANAGED_CHANNEL_LIMITS.maxSegments * 49_149);
    const pieces = planChannelSegments(text);
    expect(pieces).toHaveLength(MANAGED_CHANNEL_LIMITS.maxSegments);
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(maxBytes);
      expect(piece).not.toContain(REPLACEMENT_CHARACTER);
    }
    const join = pieces.join('');
    expect(join.endsWith(CHANNEL_CAPACITY_NOTICE)).toBe(true);
    const kept = join.slice(0, join.length - CHANNEL_CAPACITY_NOTICE.length);
    expect(text.startsWith(kept)).toBe(true);
    const lost =
      Buffer.byteLength(text, 'utf8') - Buffer.byteLength(kept, 'utf8');
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThanOrEqual(
      3 * MANAGED_CHANNEL_LIMITS.maxSegments +
        Buffer.byteLength(CHANNEL_CAPACITY_NOTICE, 'utf8'),
    );
  });

  it('keeps 64 segments past the count bound and marks the truncation', () => {
    const maxBytes = MANAGED_CHANNEL_LIMITS.maxSegmentBytes;
    const text = 'x'.repeat(
      maxBytes * MANAGED_CHANNEL_LIMITS.maxSegments + 1_000,
    );
    const pieces = planChannelSegments(text);
    expect(pieces).toHaveLength(MANAGED_CHANNEL_LIMITS.maxSegments);
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece, 'utf8')).toBeLessThanOrEqual(maxBytes);
    }
    expect(
      pieces
        .slice(0, -1)
        .every((piece) => !piece.includes(CHANNEL_CAPACITY_NOTICE)),
    ).toBe(true);
    const last = pieces[pieces.length - 1]!;
    expect(last.endsWith(CHANNEL_CAPACITY_NOTICE)).toBe(true);
    // The join is the kept prefix plus the notice — a strict prefix of the
    // input, never a silent loss and never a mid-code-point cut.
    const join = pieces.join('');
    const kept = join.slice(0, join.length - CHANNEL_CAPACITY_NOTICE.length);
    expect(text.startsWith(kept)).toBe(true);
    expect(kept.length).toBeLessThan(text.length);
    expect(join).not.toContain(REPLACEMENT_CHARACTER);
  });

  it('drops an emoji at the cut point whole, never as a replacement character', () => {
    // The leading byte shifts every 48 KiB cut into the middle of a 4-byte
    // code point, so the boundary back-off must drop the emoji whole.
    const text = 'x' + '🙂'.repeat(40_000);
    const segment = planChannelSegments(text).join('');
    expect(segment).toBe(text);
    expect(segment).not.toContain('�');
  });

  it('truncates emoji-heavy text only on code-point boundaries under any byte budget', () => {
    expect(truncateChannelTextUtf8('short', 128)).toBe('short');
    const noticeBytes = Buffer.byteLength(CHANNEL_TRUNCATION_NOTICE, 'utf8');
    for (const budget of [4, 5, 100, 1_000]) {
      const cut = truncateChannelTextUtf8(`${'🙂'.repeat(10_000)}x`, budget);
      expect(cut.endsWith(CHANNEL_TRUNCATION_NOTICE)).toBe(true);
      // The notice is irreducible: below its byte length the budget can
      // only hold the notice itself.
      expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(
        Math.max(budget, noticeBytes),
      );
      // No orphan surrogate and no replacement character — an emoji at
      // the cut point is dropped whole, never split into U+D83D.
      expect(cut).not.toContain('�');
      const core = cut.slice(0, cut.length - CHANNEL_TRUNCATION_NOTICE.length);
      if (core.length > 0) expect(core.endsWith('🙂')).toBe(true);
    }
  });
});

describe('channel route bodies', () => {
  it('opens a route the contract accepts and rolls its generation forward', () => {
    const opened = openRoute();
    expect(parseChannelRoute(opened)).toEqual(opened);
    expect(isChannelRouteStart(opened)).toBe(true);
    const rolled = channelRouteRolloverBody(opened, { accountGeneration: 3 });
    expect(rolled).toMatchObject({ routeRevision: 2, accountGeneration: 3 });
    expect(isChannelRouteSuccessor(opened, rolled)).toBe(true);
    expect(() =>
      channelRouteRolloverBody(opened, { accountGeneration: 2 }),
    ).toThrow(/channel_generation_stale/);
    expect(() =>
      channelRouteRolloverBody(opened, { accountGeneration: 1 }),
    ).toThrow(/channel_generation_stale/);
  });
});

describe('channel delivery bodies', () => {
  it('walks plan → sending → partial → sending → delivered as contract successors', () => {
    const planned = plan();
    expect(parseChannelDelivery(planned)).toEqual(planned);
    expect(isChannelDeliveryStart(planned)).toBe(true);
    const sending = channelDeliverySendingBody(planned);
    expect(isChannelDeliverySuccessor(planned, sending)).toBe(true);
    const partial = channelDeliveryReceiptBody(sending, 0, RECEIPT);
    expect(partial.run.delivery?.state).toBe('partial');
    expect(isChannelDeliverySuccessor(sending, partial)).toBe(true);
    const resumed = channelDeliverySendingBody(partial);
    expect(isChannelDeliverySuccessor(partial, resumed)).toBe(true);
    const delivered = channelDeliveryReceiptBody(resumed, 1, {
      ...RECEIPT,
      providerMessageId: '<m2@example.com>',
    });
    expect(delivered.run).toMatchObject({
      state: 'settled',
      delivery: { state: 'delivered' },
    });
    expect(isChannelDeliverySuccessor(resumed, delivered)).toBe(true);
    expect(() => channelDeliveryReceiptBody(delivered, 1, RECEIPT)).toThrow(
      /already has a receipt/,
    );
    expect(() => channelDeliveryReceiptBody(delivered, 7, RECEIPT)).toThrow(
      /no segment 7/,
    );
  });

  it('settles unknown, late-proves it, rejects, and cancels only a planned one', () => {
    const sending = channelDeliverySendingBody(plan());
    const unknown = channelDeliveryUnknownBody(sending);
    expect(unknown.run).toMatchObject({
      state: 'waiting',
      reason: null,
      delivery: { state: 'unknown' },
    });
    expect(isChannelDeliverySuccessor(sending, unknown)).toBe(true);
    // A late provider proof completes an unknown delivery: late completion
    // wins, as the H5a successor corpus pins.
    const lateOne = channelDeliveryReceiptBody(unknown, 0, RECEIPT);
    expect(lateOne.run).toMatchObject({
      state: 'waiting',
      delivery: { state: 'partial' },
    });
    expect(isChannelDeliverySuccessor(unknown, lateOne)).toBe(true);
    const rejected = channelDeliveryRejectedBody(unknown);
    expect(rejected.run).toMatchObject({
      state: 'failed',
      delivery: { state: 'rejected' },
    });
    expect(isChannelDeliverySuccessor(unknown, rejected)).toBe(true);
    expect(
      isChannelDeliverySuccessor(sending, channelDeliveryRejectedBody(sending)),
    ).toBe(true);
    const requested = channelDeliveryCancelRequestedBody(sending);
    expect(isChannelDeliverySuccessor(sending, requested)).toBe(true);
    expect(() => channelDeliveryCancelledBody(sending)).toThrow(
      /can no longer be cancelled/,
    );
    const cancelled = channelDeliveryCancelledBody(plan());
    expect(cancelled).toMatchObject({
      cancelRequested: true,
      run: { state: 'cancelled', delivery: { state: 'cancelled' } },
    });
    expect(isChannelDeliverySuccessor(plan(), cancelled)).toBe(true);
  });

  it('resends only the segments proven unsent, as a new chain', () => {
    const partialThenUnknown = channelDeliveryUnknownBody(
      channelDeliveryReceiptBody(
        channelDeliverySendingBody(plan(3)),
        1,
        RECEIPT,
      ),
    );
    expect(channelDeliveryResendable(partialThenUnknown)).toBe(true);
    const resend = channelDeliveryResendBody(partialThenUnknown, 'd-1:r1');
    expect(resend.deliveryId).toBe('d-1:r1');
    expect(resend.segments.map((segment) => segment.segmentId)).toEqual([
      'd-1:0',
      'd-1:2',
    ]);
    expect(resend.segments.map((segment) => segment.ordinal)).toEqual([0, 1]);
    expect(resend.segments.every((segment) => segment.receipt === null)).toBe(
      true,
    );
    expect(resend).toMatchObject({
      routeId: 'chrt-x',
      routeRevision: 1,
      sourceTurnId: 'turn-1',
      run: { state: 'admitted', delivery: { state: 'planned' } },
    });
    expect(isChannelDeliveryStart(resend)).toBe(true);
    for (const settled of [
      plan(),
      channelDeliverySendingBody(plan()),
      channelDeliveryReceiptBody(
        channelDeliverySendingBody(plan(1)),
        0,
        RECEIPT,
      ),
    ]) {
      expect(channelDeliveryResendable(settled)).toBe(false);
      expect(() => channelDeliveryResendBody(settled, 'd-1:r1')).toThrow(
        /cannot be resent/,
      );
    }
    expect(() =>
      channelDeliveryPlanBody({
        deliveryId: 'd-2',
        routeId: 'chrt-x',
        routeRevision: 1,
        sourceTurnId: 'turn-1',
        contentRef: ref('reply-1', 'reply'),
        segments: [],
      }),
    ).toThrow(/1 to 64 segments/);
  });
});
