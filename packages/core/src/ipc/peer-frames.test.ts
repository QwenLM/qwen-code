/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildAuthLine,
  buildDeliveryStatusFrame,
  buildUserFrame,
  canonicalizeMsgId,
  describeDeliveryStatus,
  describeDropReason,
  encodePeerFrame,
  MAX_DROPPED_MSG_IDS,
  MAX_RETAINED_REPLY_TOKEN_CHARS,
  parsePeerAuthLine,
  parsePeerFrame,
  PEER_FRAME_VERSION,
  type PeerFrame,
} from './peer-frames.js';

function line(value: unknown): string {
  return JSON.stringify(value);
}

const validUser = {
  msgV: 1,
  msgId: 'abc',
  type: 'user',
  priority: 'next',
  message: { role: 'user', content: 'hello' },
};

/** Parses `validUser` with `over` spread on top. */
const parseUser = (over: Record<string, unknown>) =>
  parsePeerFrame(line({ ...validUser, ...over }));

/** Encodes `frame`, then parses the line back. */
const roundTrip = (frame: PeerFrame) =>
  parsePeerFrame(encodePeerFrame(frame).trimEnd());

describe('parsePeerFrame — user frames', () => {
  it('parses a minimal valid frame', () => {
    const frame = parsePeerFrame(line(validUser));
    expect(frame).toMatchObject({
      type: 'user',
      msgId: 'abc',
      priority: 'next',
      message: { role: 'user', content: 'hello' },
    });
  });

  it('carries from, fromName and fromMode through', () => {
    const sender = {
      from: '/run/user/1000/qwen-socks/9.sock',
      fromName: 'app-ab',
      fromMode: 'bypass',
    };
    expect(parseUser(sender)).toMatchObject(sender);
  });

  it('carries the recipient session id through', () => {
    expect(parseUser({ toSessionId: 'sess-9' })).toMatchObject({
      toSessionId: 'sess-9',
    });
  });

  it('delivers a message whose reply token is too large to retain', () => {
    // The token only routes the receipt, and the bound is applied where
    // it is held (`peer-drop-reports.ts`). Refusing the frame here would
    // lose an ordinary message over a field that says nothing about it.
    const frame = parseUser({
      replyToken: 'x'.repeat(MAX_RETAINED_REPLY_TOKEN_CHARS + 1),
    });
    expect(frame).not.toBeNull();
    expect(frame && 'message' in frame && frame.message.content).toBe('hello');
  });

  it('treats a non-string toSessionId as unaddressed', () => {
    const frame = parseUser({ toSessionId: 7 });
    expect(frame).not.toBeNull();
    expect(frame && 'toSessionId' in frame).toBe(false);
  });

  it('drops an unrecognized fromMode rather than trusting it', () => {
    const frame = parseUser({ fromMode: 'root' });
    expect(frame).not.toBeNull();
    expect(frame && 'fromMode' in frame).toBe(false);
  });

  it('defaults an unknown priority to next', () => {
    for (const priority of ['urgent', undefined]) {
      expect(parseUser({ priority })).toMatchObject({ priority: 'next' });
    }
  });

  it('keeps an explicit now priority', () => {
    expect(parseUser({ priority: 'now' })).toMatchObject({ priority: 'now' });
  });

  it.each([
    ['not json', 'nonsense{'],
    ['an array', line([validUser])],
    ['a bare string', line('hello')],
    ['null', line(null)],
  ])('rejects %s', (_label, input) => {
    expect(parsePeerFrame(input)).toBeNull();
  });

  it.each([
    ['a missing msgId', { msgId: undefined }],
    ['an empty msgId', { msgId: '' }],
    ['a non-string msgId', { msgId: 7 }],
    ['a missing message', { message: undefined }],
    ['a non-user role', { message: { role: 'system', content: 'x' } }],
    ['empty content', { message: { role: 'user', content: '' } }],
    ['non-string content', { message: { role: 'user', content: 5 } }],
    ['an unknown type', { type: 'shell' }],
    ['a missing msgV', { msgV: undefined }],
  ])('rejects a frame with %s', (_label, input) => {
    expect(parseUser(input)).toBeNull();
  });

  // /peers tokenizes user input on whitespace and prints dash-stripped
  // handles, so an id that contains whitespace or reduces to nothing has
  // no typable handle: one such message defeats per-message review, and
  // a benign-plus-malicious pair forces an `accept all` that releases the
  // malicious entry unreviewed.
  it.each([
    ['a leading-whitespace msgId', { msgId: ' urgent' }],
    ['an NBSP-prefixed msgId', { msgId: '\u00a0urgent' }],
    ['an internal-whitespace msgId', { msgId: 'task0001 benign update' }],
    ['a trailing-whitespace msgId', { msgId: 'abc ' }],
    ['a dash-only msgId', { msgId: '---' }],
    ['an overlong msgId', { msgId: 'a'.repeat(65) }],
    ['a msgId outside the handle charset', { msgId: 'task/0001' }],
  ])('rejects %s so every held id stays typeable', (_label, input) => {
    expect(parseUser(input)).toBeNull();
  });

  // `all` is the /peers bulk keyword, intercepted before any id
  // resolution: a held message wearing that handle could never be decided
  // individually, and acting on it would decide every held message.
  it.each([
    ['the exact bulk keyword', { msgId: 'all' }],
    ['a dash-spelled bulk keyword', { msgId: 'a-l-l' }],
    ['an upper-case bulk keyword', { msgId: 'ALL' }],
  ])('rejects %s so it cannot alias /peers all', (_label, input) => {
    expect(parseUser(input)).toBeNull();
  });

  it('still admits ids that merely contain the keyword', () => {
    expect(parseUser({ msgId: 'all-nodes-restart-001' })).not.toBeNull();
  });

  it('accepts the id shape legitimate senders produce', () => {
    const frame = buildUserFrame({ content: 'hi' });
    expect(roundTrip(frame)).toMatchObject({ msgId: frame.msgId });
    expect(parseUser({ msgId: 'Task-0001' })).not.toBeNull();
    expect(parseUser({ msgId: 'a'.repeat(64) })).not.toBeNull();
  });

  it('rejects a frame from a newer protocol rather than guessing', () => {
    expect(parseUser({ msgV: PEER_FRAME_VERSION + 1 })).toBeNull();
  });
});

describe('parsePeerFrame — control frames', () => {
  const validControl = {
    msgV: 1,
    msgId: 'c1',
    type: 'control',
    action: 'delivery_status',
    status: 'held',
    origMsgId: 'abc',
  };

  it('parses every delivery status, including misaddressed', () => {
    for (const status of [
      'held',
      'denied',
      'expired',
      'delivered',
      'misaddressed',
    ]) {
      expect(parsePeerFrame(line({ ...validControl, status }))).toMatchObject({
        status,
      });
    }
  });

  it('parses a delivery status', () => {
    expect(parsePeerFrame(line(validControl))).toMatchObject({
      type: 'control',
      status: 'held',
      origMsgId: 'abc',
    });
  });

  it.each([
    ['an unknown action', { ...validControl, action: 'reboot' }],
    ['an unknown status', { ...validControl, status: 'maybe' }],
    ['a missing origMsgId', { ...validControl, origMsgId: undefined }],
    ['a whitespace-bearing msgId', { ...validControl, msgId: 'has space' }],
    ['a bulk-keyword msgId', { ...validControl, msgId: 'all' }],
  ])('rejects a control frame with %s', (_label, input) => {
    expect(parsePeerFrame(line(input))).toBeNull();
  });
});

describe('canonicalizeMsgId', () => {
  it('is the equivalence /peers resolution and the gate dedupe share', () => {
    expect(canonicalizeMsgId('Task-0001')).toBe(canonicalizeMsgId('task0001'));
    expect(canonicalizeMsgId('ABCDEF')).toBe('abcdef');
  });
});

describe('round trip', () => {
  it('encodes with a trailing newline and parses back', () => {
    const frame = buildUserFrame({ content: 'hi', from: '/tmp/a.sock' });
    const encoded = encodePeerFrame(frame);
    expect(encoded.endsWith('\n')).toBe(true);
    expect(encoded.indexOf('\n')).toBe(encoded.length - 1);
    expect(parsePeerFrame(encoded.trimEnd())).toEqual(frame);
  });

  it('round-trips the recipient session id', () => {
    const frame = buildUserFrame({ content: 'hi', toSessionId: 'sess-9' });
    expect(frame.toSessionId).toBe('sess-9');
    expect(roundTrip(frame)).toEqual(frame);
  });

  it('omits the recipient key rather than writing undefined', () => {
    expect('toSessionId' in buildUserFrame({ content: 'hi' })).toBe(false);
  });

  it('round-trips the reply token, and omits its key when absent', () => {
    const frame = buildUserFrame({ content: 'hi', replyToken: 'tok' });
    expect(roundTrip(frame)).toEqual(frame);
    expect('replyToken' in buildUserFrame({ content: 'hi' })).toBe(false);
  });

  it('survives content containing newlines', () => {
    const frame = buildUserFrame({ content: 'line one\nline two' });
    const encoded = encodePeerFrame(frame);
    // JSON escapes the newline, so the frame is still exactly one line.
    expect(encoded.split('\n').filter(Boolean)).toHaveLength(1);
    expect(parsePeerFrame(encoded.trimEnd())).toEqual(frame);
  });

  it('gives every frame a distinct id', () => {
    expect(buildUserFrame({ content: 'a' }).msgId).not.toBe(
      buildUserFrame({ content: 'a' }).msgId,
    );
  });
});

describe('delivery status frames', () => {
  it('explains each status', () => {
    expect(describeDeliveryStatus('held')).toContain('review');
    expect(describeDeliveryStatus('denied')).toContain('declined');
    expect(describeDeliveryStatus('expired')).toContain('expired');
    expect(describeDeliveryStatus('delivered')).toContain('released');
    expect(describeDeliveryStatus('misaddressed')).toContain(
      'different session',
    );
    expect(describeDeliveryStatus('misaddressed')).not.toContain('declined');
  });

  it('separates a refusal from a decision', () => {
    // The sender's model acts on these differently: 'denied' is a person
    // saying no and may be worth raising with them, 'refused' means the
    // session takes no peer messages and re-sending is pointless.
    const refused = describeDeliveryStatus('refused');
    expect(refused).toContain('does not accept messages');
    expect(refused).not.toContain('declined');
    expect(describeDeliveryStatus('denied')).not.toContain(
      'does not accept messages',
    );
  });

  it('accepts a refused receipt off the wire', () => {
    const frame = buildDeliveryStatusFrame({
      status: 'refused',
      origMsgId: 'abc',
    });
    const parsed = parsePeerFrame(encodePeerFrame(frame));
    expect(parsed).toMatchObject({ type: 'control', status: 'refused' });
  });

  it('carries the reason on the frame so the sender need not map it', () => {
    const frame = buildDeliveryStatusFrame({
      status: 'held',
      origMsgId: 'abc',
      from: '/tmp/a.sock',
    });
    expect(frame.reason).toBe(describeDeliveryStatus('held'));
    expect(frame.origMsgId).toBe('abc');
  });
});

describe('auth lines', () => {
  it('round-trips a token on one newline-terminated line', () => {
    const line = buildAuthLine('tok-123');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(parsePeerAuthLine(line.trimEnd())).toBe('tok-123');
  });

  it('is not a peer frame — a tokenless inbox skips it as unparseable', () => {
    expect(parsePeerFrame(buildAuthLine('tok').trimEnd())).toBeNull();
  });

  it('rejects everything that is not exactly an auth line', () => {
    expect(parsePeerAuthLine('not json')).toBeNull();
    expect(parsePeerAuthLine(line({ ...validUser }))).toBeNull();
    const parseAuth = (over: Record<string, unknown>) =>
      parsePeerAuthLine(line({ msgV: 1, type: 'auth', ...over }));
    expect(parseAuth({})).toBeNull();
    expect(parseAuth({ token: '' })).toBeNull();
    expect(parseAuth({ token: 42 })).toBeNull();
    expect(
      parseAuth({ msgV: PEER_FRAME_VERSION + 1, token: 'tok' }),
    ).toBeNull();
  });
});

describe('dropped receipts', () => {
  const tooMany = Array.from(
    { length: MAX_DROPPED_MSG_IDS + 20 },
    (_, index) => `id${index}`,
  );

  type StatusFields = Parameters<typeof buildDeliveryStatusFrame>[0];
  /** A `dropped` receipt for `orig-1`, with `fields` on top. */
  const buildDropped = (fields: Partial<StatusFields> = {}) =>
    buildDeliveryStatusFrame({
      status: 'dropped',
      origMsgId: 'orig-1',
      ...fields,
    });

  function parseControl(over: Record<string, unknown>) {
    return parsePeerFrame(
      JSON.stringify({
        msgV: 1,
        msgId: 'a1',
        type: 'control',
        action: 'delivery_status',
        status: 'dropped',
        origMsgId: 'orig-1',
        ...over,
      }),
    );
  }

  it('parses a drop with its reason and the ids it folds in', () => {
    const folded = { dropReason: 'rate-limited', droppedMsgIds: ['b2', 'c3'] };
    expect(parseControl(folded)).toMatchObject({
      status: 'dropped',
      origMsgId: 'orig-1',
      ...folded,
    });
  });

  it('accepts a drop that names neither', () => {
    const parsed = parseControl({});
    expect(parsed).toMatchObject({ status: 'dropped' });
    expect(parsed).not.toHaveProperty('dropReason');
    expect(parsed).not.toHaveProperty('droppedMsgIds');
  });

  it('ignores a reason it does not know', () => {
    expect(parseControl({ dropReason: 'because' })).not.toHaveProperty(
      'dropReason',
    );
  });

  it('skips ids that could not name a message, keeping the rest', () => {
    // Written by the receiver, but drawn from what senders put on the
    // wire: an id the parser would refuse at the top of a frame must not
    // arrive inside one.
    const parsed = parseControl({
      droppedMsgIds: ['b2', 'has space', '', 'all', '-leading', 42, 'c3'],
    });
    expect(parsed).toMatchObject({ droppedMsgIds: ['b2', 'c3'] });
  });

  it('ignores a list that is not a list', () => {
    expect(parseControl({ droppedMsgIds: 'b2' })).not.toHaveProperty(
      'droppedMsgIds',
    );
  });

  it('caps how many ids one receipt can settle', () => {
    const parsed = parseControl({ droppedMsgIds: tooMany });
    expect((parsed as { droppedMsgIds?: string[] }).droppedMsgIds).toHaveLength(
      MAX_DROPPED_MSG_IDS,
    );
  });

  it('reads the two fields off no other status', () => {
    // A peer must not be able to settle a list of messages by attaching
    // it to a receipt that says nothing about them.
    const parsed = parseControl({
      status: 'delivered',
      dropReason: 'rate-limited',
      droppedMsgIds: ['b2'],
    });
    expect(parsed).toMatchObject({ status: 'delivered' });
    expect(parsed).not.toHaveProperty('dropReason');
    expect(parsed).not.toHaveProperty('droppedMsgIds');
  });

  it('writes the two fields only when they are given', () => {
    const bare = buildDropped();
    expect(bare).not.toHaveProperty('dropReason');
    expect(bare).not.toHaveProperty('droppedMsgIds');

    const given: Partial<StatusFields> = {
      dropReason: 'queue-full',
      droppedMsgIds: ['b2'],
    };
    expect(buildDropped(given)).toMatchObject(given);
  });

  it('leaves an empty list off the wire', () => {
    const frame = buildDropped({ droppedMsgIds: [] });
    expect(frame).not.toHaveProperty('droppedMsgIds');
  });

  it('round-trips a folded receipt', () => {
    const built = buildDropped({
      from: '/tmp/a.sock',
      dropReason: 'duplicate',
      droppedMsgIds: ['b2', 'c3'],
    });
    expect(roundTrip(built)).toEqual(built);
  });

  it('caps the ids the builder puts on the wire, and round-trips them', () => {
    // The parser's cap and the builder's are separate lines; only a
    // round trip pins them to the same ceiling.
    const built = buildDropped({
      dropReason: 'rate-limited',
      droppedMsgIds: tooMany,
    });
    expect(built.droppedMsgIds).toHaveLength(MAX_DROPPED_MSG_IDS);
    expect(roundTrip(built)).toEqual(built);
  });

  it('explains each reason to the sending session', () => {
    for (const [reason, text] of [
      ['rate-limited', 'you sent faster than that session accepts'],
      ['duplicate', 'it repeated your previous message'],
      ['queue-full', 'its queue of undelivered peer messages was full'],
    ] as const) {
      expect(describeDropReason(reason)).toBe(text);
    }
  });

  it('tells a sender not to re-send', () => {
    expect(describeDeliveryStatus('dropped')).toContain('Treat it as unsent');
  });
});
