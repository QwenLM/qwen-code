/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApprovalMode } from '../config/approval-mode.js';
import { PeerSendError } from './uds-client.js';

const readOwnSessionRecord = vi.fn();
const listMessageablePeers = vi.fn();
const sendPeerFrame = vi.fn();

vi.mock('../services/session-registry.js', () => ({
  readOwnSessionRecord: (...args: unknown[]) => readOwnSessionRecord(...args),
}));
vi.mock('./uds-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('./uds-client.js')>('./uds-client.js');
  return {
    ...actual,
    sendPeerFrame: (...args: unknown[]) => sendPeerFrame(...args),
    probePeerSocket: vi.fn().mockResolvedValue(true),
  };
});
vi.mock('./peer-directory.js', async () => {
  const actual = await vi.importActual<typeof import('./peer-directory.js')>(
    './peer-directory.js',
  );
  return {
    ...actual,
    listMessageablePeers: (...args: unknown[]) => listMessageablePeers(...args),
  };
});

const { describeSendFailure, getOwnPeerIdentity, sendToPeer } = await import(
  './peer-send.js'
);
const { peerRef } = await import('./peer-directory.js');

function peer(sessionId: string, name: string, cwd = '/w/app') {
  return {
    sessionId,
    name,
    ref: peerRef(sessionId),
    cwd,
    pid: 100,
    ipcPath: `/tmp/${sessionId}.sock`,
    startedAt: 1_000,
  };
}

const SELF = {
  schemaVersion: 1,
  pid: 1,
  procStart: null,
  sessionId: 'self',
  cwd: '/w/self',
  name: 'self-00',
  kind: 'interactive' as const,
  startedAt: 1,
  qwenVersion: null,
  peerProtocol: 1,
  ipcPath: '/tmp/self.sock',
};

beforeEach(() => {
  readOwnSessionRecord.mockReset();
  listMessageablePeers.mockReset();
  sendPeerFrame.mockReset();
  readOwnSessionRecord.mockResolvedValue(SELF);
  listMessageablePeers.mockResolvedValue([]);
  sendPeerFrame.mockResolvedValue(undefined);
});

describe('getOwnPeerIdentity', () => {
  it('is null when this session never registered', async () => {
    readOwnSessionRecord.mockResolvedValue(null);
    expect(await getOwnPeerIdentity()).toBeNull();
  });

  it('is null when this session has no inbox — the send-side gate', async () => {
    readOwnSessionRecord.mockResolvedValue({ ...SELF, ipcPath: undefined });
    expect(await getOwnPeerIdentity()).toBeNull();
  });

  it('returns the reply address and name', async () => {
    expect(await getOwnPeerIdentity()).toEqual({
      ipcPath: '/tmp/self.sock',
      name: 'self-00',
    });
  });
});

describe('sendToPeer', () => {
  it('reports disabled when this session has no inbox', async () => {
    readOwnSessionRecord.mockResolvedValue({ ...SELF, ipcPath: undefined });
    expect(
      await sendToPeer({
        target: 'app-ab',
        message: 'hi',
        approvalMode: ApprovalMode.DEFAULT,
      }),
    ).toEqual({ kind: 'disabled' });
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('delivers to a uniquely named peer', async () => {
    const target = peer('s1', 'app-ab');
    listMessageablePeers.mockResolvedValue([target]);

    const outcome = await sendToPeer({
      target: 'app-ab',
      message: 'check the tests',
      approvalMode: ApprovalMode.DEFAULT,
    });

    expect(outcome).toMatchObject({ kind: 'sent', address: 'app-ab' });
    expect(sendPeerFrame).toHaveBeenCalledTimes(1);
    const [socketPath, frame] = sendPeerFrame.mock.calls[0];
    expect(socketPath).toBe('/tmp/s1.sock');
    expect(frame).toMatchObject({
      type: 'user',
      from: '/tmp/self.sock',
      fromName: 'self-00',
      fromMode: 'prompting',
      message: { role: 'user', content: 'check the tests' },
    });
  });

  // parsePeerFrame rejects empty content and the inbox drops what it
  // cannot parse without a delivery status, so 'sent' would be a lie.
  it('refuses an empty message instead of reporting it sent', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);

    const outcome = await sendToPeer({
      target: 'app-ab',
      message: '',
      approvalMode: ApprovalMode.DEFAULT,
    });

    expect(outcome).toEqual({ kind: 'empty' });
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('asserts bypass when this session is in YOLO', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.YOLO,
    });
    expect(sendPeerFrame.mock.calls[0][1]).toMatchObject({
      fromMode: 'bypass',
    });
  });

  it('asserts nothing when the mode is unknown, rather than claiming parity', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    await sendToPeer({ target: 'app-ab', message: 'hi', approvalMode: null });
    expect(sendPeerFrame.mock.calls[0][1]).not.toHaveProperty('fromMode');
  });

  it('never addresses itself', async () => {
    // A record for this very session can appear in the directory; sending
    // to it would loop a message back into our own queue.
    listMessageablePeers.mockResolvedValue([
      { ...peer('self', 'self-00', '/w/self'), ipcPath: '/tmp/self.sock' },
    ]);

    const outcome = await sendToPeer({
      target: 'self-00',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(outcome.kind).toBe('not-found');
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('refuses an ambiguous name and lists the candidates', async () => {
    listMessageablePeers.mockResolvedValue([
      peer('s1', 'app-ab', '/w/one'),
      peer('s2', 'app-ab', '/w/two'),
    ]);

    const outcome = await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });

    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.matches).toHaveLength(2);
      expect(outcome.matches[0]).toContain('/w/one');
    }
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('delivers to the one named by "name [ref]"', async () => {
    const one = peer('s1', 'app-ab', '/w/one');
    const two = peer('s2', 'app-ab', '/w/two');
    listMessageablePeers.mockResolvedValue([one, two]);

    const outcome = await sendToPeer({
      target: `app-ab [${two.ref}]`,
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });

    expect(outcome).toMatchObject({ kind: 'sent' });
    expect(sendPeerFrame.mock.calls[0][0]).toBe('/tmp/s2.sock');
  });

  it('suggests near-misses when the name is unknown', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'qwen-code-f7')]);
    const outcome = await sendToPeer({
      target: 'qwen-code',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(outcome).toEqual({
      kind: 'not-found',
      suggestions: ['qwen-code-f7'],
    });
  });

  it('reports a send failure against the address it tried', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    sendPeerFrame.mockRejectedValue(new PeerSendError('gone', 'ECONNREFUSED'));

    const outcome = await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });

    expect(outcome).toMatchObject({ kind: 'failed', address: 'app-ab' });
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('stale');
    }
  });
});

describe('describeSendFailure', () => {
  it('tells a stale address apart from a busy one', () => {
    expect(describeSendFailure(new PeerSendError('x', 'ENOENT'))).toContain(
      'stale',
    );
    expect(
      describeSendFailure(new PeerSendError('x', 'ECONNREFUSED')),
    ).toContain('stale');
    expect(describeSendFailure(new PeerSendError('x', 'EBUSY'))).toContain(
      'Retry the same name',
    );
  });

  it('explains a timeout as the peer not reading', () => {
    expect(describeSendFailure(new PeerSendError('x', 'ETIMEDOUT'))).toContain(
      'never read',
    );
  });

  it('falls back to the message for anything else', () => {
    expect(describeSendFailure(new PeerSendError('weird', 'EWEIRD'))).toBe(
      'weird',
    );
    expect(describeSendFailure(new Error('plain'))).toBe('plain');
    expect(describeSendFailure('a string')).toBe('a string');
  });
});
