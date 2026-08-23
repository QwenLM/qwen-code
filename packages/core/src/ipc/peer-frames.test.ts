/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  buildDeliveryStatusFrame,
  buildUserFrame,
  canonicalizeMsgId,
  describeDeliveryStatus,
  encodePeerFrame,
  parsePeerFrame,
  PEER_FRAME_VERSION,
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
    const frame = parsePeerFrame(
      line({
        ...validUser,
        from: '/run/user/1000/qwen-socks/9.sock',
        fromName: 'app-ab',
        fromMode: 'bypass',
      }),
    );
    expect(frame).toMatchObject({
      from: '/run/user/1000/qwen-socks/9.sock',
      fromName: 'app-ab',
      fromMode: 'bypass',
    });
  });

  it('drops an unrecognized fromMode rather than trusting it', () => {
    const frame = parsePeerFrame(line({ ...validUser, fromMode: 'root' }));
    expect(frame).not.toBeNull();
    expect(frame && 'fromMode' in frame).toBe(false);
  });

  it('defaults an unknown priority to next', () => {
    expect(
      parsePeerFrame(line({ ...validUser, priority: 'urgent' })),
    ).toMatchObject({ priority: 'next' });
    expect(
      parsePeerFrame(line({ ...validUser, priority: undefined })),
    ).toMatchObject({ priority: 'next' });
  });

  it('keeps an explicit now priority', () => {
    expect(
      parsePeerFrame(line({ ...validUser, priority: 'now' })),
    ).toMatchObject({ priority: 'now' });
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
    ['a missing msgId', { ...validUser, msgId: undefined }],
    ['an empty msgId', { ...validUser, msgId: '' }],
    ['a non-string msgId', { ...validUser, msgId: 7 }],
    ['a missing message', { ...validUser, message: undefined }],
    [
      'a non-user role',
      { ...validUser, message: { role: 'system', content: 'x' } },
    ],
    ['empty content', { ...validUser, message: { role: 'user', content: '' } }],
    [
      'non-string content',
      { ...validUser, message: { role: 'user', content: 5 } },
    ],
    ['an unknown type', { ...validUser, type: 'shell' }],
    ['a missing msgV', { ...validUser, msgV: undefined }],
  ])('rejects a frame with %s', (_label, input) => {
    expect(parsePeerFrame(line(input))).toBeNull();
  });

  // /peers tokenizes user input on whitespace and prints dash-stripped
  // handles, so an id that contains whitespace or reduces to nothing has
  // no typable handle: one such message defeats per-message review, and
  // a benign-plus-malicious pair forces an `accept all` that releases the
  // malicious entry unreviewed.
  it.each([
    ['a leading-whitespace msgId', { ...validUser, msgId: ' urgent' }],
    ['an NBSP-prefixed msgId', { ...validUser, msgId: '\u00a0urgent' }],
    [
      'an internal-whitespace msgId',
      { ...validUser, msgId: 'task0001 benign update' },
    ],
    ['a trailing-whitespace msgId', { ...validUser, msgId: 'abc ' }],
    ['a dash-only msgId', { ...validUser, msgId: '---' }],
    ['an overlong msgId', { ...validUser, msgId: 'a'.repeat(65) }],
    [
      'a msgId outside the handle charset',
      { ...validUser, msgId: 'task/0001' },
    ],
  ])('rejects %s so every held id stays typeable', (_label, input) => {
    expect(parsePeerFrame(line(input))).toBeNull();
  });

  // `all` is the /peers bulk keyword, intercepted before any id
  // resolution: a held message wearing that handle could never be decided
  // individually, and acting on it would decide every held message.
  it.each([
    ['the exact bulk keyword', { ...validUser, msgId: 'all' }],
    ['a dash-spelled bulk keyword', { ...validUser, msgId: 'a-l-l' }],
    ['an upper-case bulk keyword', { ...validUser, msgId: 'ALL' }],
  ])('rejects %s so it cannot alias /peers all', (_label, input) => {
    expect(parsePeerFrame(line(input))).toBeNull();
  });

  it('still admits ids that merely contain the keyword', () => {
    expect(
      parsePeerFrame(line({ ...validUser, msgId: 'all-nodes-restart-001' })),
    ).not.toBeNull();
  });

  it('accepts the id shape legitimate senders produce', () => {
    const frame = buildUserFrame({ content: 'hi' });
    expect(parsePeerFrame(encodePeerFrame(frame).trimEnd())).toMatchObject({
      msgId: frame.msgId,
    });
    expect(
      parsePeerFrame(line({ ...validUser, msgId: 'Task-0001' })),
    ).not.toBeNull();
    expect(
      parsePeerFrame(line({ ...validUser, msgId: 'a'.repeat(64) })),
    ).not.toBeNull();
  });

  it('rejects a frame from a newer protocol rather than guessing', () => {
    expect(
      parsePeerFrame(line({ ...validUser, msgV: PEER_FRAME_VERSION + 1 })),
    ).toBeNull();
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
