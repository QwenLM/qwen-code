/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildAuthLine,
  buildDeliveryStatusFrame,
  buildUserFrame,
  canonicalizeMsgId,
  encodePeerFrame,
  isPeerMsgId,
  MAX_DROPPED_MSG_IDS,
  parsePeerAuthLine,
  parsePeerFrame,
  type PeerControlFrame,
  type PeerUserFrame,
} from '../../../src/peer/frames.js';

const ID = '5f1d0c9e-3b2a-4e8f-9c7d-1a2b3c4d5e6f';

function user(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    msgV: 1,
    msgId: ID,
    type: 'user',
    priority: 'next',
    message: { role: 'user', content: 'build finished' },
    ...overrides,
  });
}

function control(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    msgV: 1,
    msgId: ID,
    type: 'control',
    action: 'delivery_status',
    status: 'delivered',
    origMsgId: 'orig-1',
    ...overrides,
  });
}

describe('parsePeerFrame — user frames', () => {
  it('reads every field it knows', () => {
    const frame = parsePeerFrame(
      user({
        from: '/run/user/1000/qwen-socks/1.sock',
        replyToken: 'reply',
        fromName: 'project-3f',
        fromMode: 'prompting',
        toSessionId: 'session-b',
        priority: 'now',
      }),
    ) as PeerUserFrame;
    expect(frame).toEqual({
      msgV: 1,
      msgId: ID,
      type: 'user',
      from: '/run/user/1000/qwen-socks/1.sock',
      replyToken: 'reply',
      fromName: 'project-3f',
      fromMode: 'prompting',
      toSessionId: 'session-b',
      priority: 'now',
      message: { role: 'user', content: 'build finished' },
    });
  });

  it('reads a priority it does not know as next, and ignores unknown fields', () => {
    const frame = parsePeerFrame(
      user({ priority: 'urgent', futureField: { nested: true } }),
    ) as PeerUserFrame;
    expect(frame.priority).toBe('next');
    expect(frame).not.toHaveProperty('futureField');
  });

  it('keeps fromMode only when it is one of the two classes', () => {
    expect(
      (parsePeerFrame(user({ fromMode: 'yolo' })) as PeerUserFrame).fromMode,
    ).toBeUndefined();
    expect(
      (parsePeerFrame(user({ fromMode: 'bypass' })) as PeerUserFrame).fromMode,
    ).toBe('bypass');
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['an array', '[]'],
    ['a newer msgV', user({ msgV: 2 })],
    ['a msgV that is not a number', user({ msgV: '1' })],
    ['a msgId with whitespace', user({ msgId: 'a b' })],
    ['a msgId starting with a dash', user({ msgId: '-abc' })],
    ['a msgId of 65 characters', user({ msgId: 'a'.repeat(65) })],
    ['a msgId that canonicalizes to all', user({ msgId: 'A-l-L' })],
    ['an unknown type', user({ type: 'rename' })],
    ['empty content', user({ message: { role: 'user', content: '' } })],
    [
      'a role other than user',
      user({ message: { role: 'assistant', content: 'x' } }),
    ],
    ['a message that is not an object', user({ message: 'hi' })],
  ])('drops %s', (_label, line) => {
    expect(parsePeerFrame(line)).toBeNull();
  });
});

describe('parsePeerFrame — control frames', () => {
  it('reads a receipt', () => {
    expect(
      parsePeerFrame(control({ from: '/tmp/a.sock', reason: 'ok' })),
    ).toEqual({
      msgV: 1,
      msgId: ID,
      type: 'control',
      action: 'delivery_status',
      status: 'delivered',
      origMsgId: 'orig-1',
      from: '/tmp/a.sock',
      reason: 'ok',
    });
  });

  it('reads dropReason and droppedMsgIds only on a drop', () => {
    const extras = { dropReason: 'duplicate', droppedMsgIds: ['m2', 'm3'] };
    const delivered = parsePeerFrame(control(extras)) as PeerControlFrame;
    expect(delivered.dropReason).toBeUndefined();
    expect(delivered.droppedMsgIds).toBeUndefined();

    const dropped = parsePeerFrame(
      control({ status: 'dropped', ...extras }),
    ) as PeerControlFrame;
    expect(dropped.dropReason).toBe('duplicate');
    expect(dropped.droppedMsgIds).toEqual(['m2', 'm3']);
  });

  it('keeps only well-formed dropped ids, and at most the cap', () => {
    const ids = [
      'bad id',
      'all',
      ...Array.from({ length: 300 }, (_, i) => `m${i}`),
    ];
    const frame = parsePeerFrame(
      control({ status: 'dropped', droppedMsgIds: ids }),
    ) as PeerControlFrame;
    expect(frame.droppedMsgIds).toHaveLength(MAX_DROPPED_MSG_IDS);
    expect(frame.droppedMsgIds?.[0]).toBe('m0');
  });

  it.each([
    ['an action it does not know', control({ action: 'rename' })],
    ['a status it does not know', control({ status: 'read' })],
    ['an empty origMsgId', control({ origMsgId: '' })],
  ])('drops %s', (_label, line) => {
    expect(parsePeerFrame(line)).toBeNull();
  });
});

describe('frame builders', () => {
  it('writes a user frame the parser reads back unchanged', () => {
    const frame = buildUserFrame({
      content: 'hello',
      from: '/tmp/me.sock',
      replyToken: 'tok',
      fromName: 'me',
      toSessionId: 'you',
    });
    const line = encodePeerFrame(frame);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(parsePeerFrame(line.trimEnd())).toEqual(frame);
    expect(frame.priority).toBe('next');
    expect(isPeerMsgId(frame.msgId)).toBe(true);
  });

  it('leaves drop details off a receipt that is not a drop, and an empty id list off one that is', () => {
    const delivered = buildDeliveryStatusFrame({
      status: 'delivered',
      origMsgId: 'm1',
      dropReason: 'duplicate',
      droppedMsgIds: ['m2'],
    });
    expect(delivered).not.toHaveProperty('dropReason');
    expect(delivered).not.toHaveProperty('droppedMsgIds');
    expect(delivered.reason).toEqual(expect.any(String));

    const dropped = buildDeliveryStatusFrame({
      status: 'dropped',
      origMsgId: 'm1',
      dropReason: 'rate-limited',
      droppedMsgIds: [],
    });
    expect(dropped.dropReason).toBe('rate-limited');
    expect(dropped).not.toHaveProperty('droppedMsgIds');
  });

  it('round-trips the auth line, and reads nothing else as one', () => {
    expect(parsePeerAuthLine(buildAuthLine('secret').trimEnd())).toBe('secret');
    expect(parsePeerAuthLine(user())).toBeNull();
    expect(
      parsePeerAuthLine(JSON.stringify({ msgV: 1, type: 'auth', token: '' })),
    ).toBeNull();
    expect(
      parsePeerAuthLine(JSON.stringify({ msgV: 2, type: 'auth', token: 't' })),
    ).toBeNull();
  });

  it('compares ids with dashes stripped and case folded', () => {
    expect(canonicalizeMsgId('AB-cd-EF')).toBe('abcdef');
  });
});
