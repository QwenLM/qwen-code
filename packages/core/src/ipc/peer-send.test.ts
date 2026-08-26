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

const {
  describeSendFailure,
  getOwnPeerIdentity,
  lookupSentPeerMessage,
  MAX_TRACKED_SENDS,
  resetSentPeerMessagesForTest,
  senderModeClass,
  sendToPeer,
} = await import('./peer-send.js');
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
  pidNs: null,
  sessionId: 'self',
  cwd: '/w/self',
  name: 'self-00',
  startedAt: 1,
  qwenVersion: null,
  ipcPath: '/tmp/self.sock',
};

beforeEach(() => {
  resetSentPeerMessagesForTest();
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

  it('returns the reply address, name, and the ref peers see', async () => {
    expect(await getOwnPeerIdentity()).toEqual({
      ipcPath: '/tmp/self.sock',
      name: 'self-00',
      sessionId: 'self',
      ref: peerRef('self'),
    });
  });
});

describe('senderModeClass', () => {
  it('is prompting exactly when the receiving gate would still review', () => {
    expect(senderModeClass(ApprovalMode.DEFAULT)).toBe('prompting');
    expect(senderModeClass(ApprovalMode.PLAN)).toBe('prompting');
    expect(senderModeClass(ApprovalMode.YOLO)).toBe('bypass');
    expect(senderModeClass(ApprovalMode.AUTO_EDIT)).toBe('bypass');
    expect(senderModeClass(ApprovalMode.AUTO)).toBe('bypass');
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
    expect(listMessageablePeers).not.toHaveBeenCalled();
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('delivers to a uniquely named peer, pinned to its session id', async () => {
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
      toSessionId: 's1',
      message: { role: 'user', content: 'check the tests' },
    });
  });

  it('asserts bypass when this session no longer reviews its actions', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    for (const mode of [
      ApprovalMode.YOLO,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.AUTO,
    ]) {
      sendPeerFrame.mockClear();
      await sendToPeer({ target: 'app-ab', message: 'hi', approvalMode: mode });
      expect(sendPeerFrame.mock.calls[0][1]).toMatchObject({
        fromMode: 'bypass',
      });
    }
  });

  it('asserts nothing when the mode is unknown, rather than claiming parity', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    await sendToPeer({ target: 'app-ab', message: 'hi', approvalMode: null });
    expect(sendPeerFrame.mock.calls[0][1]).not.toHaveProperty('fromMode');
  });

  it('names the mistake when the target is this session itself', async () => {
    // A record for this very session appears in the directory; sending
    // to it would loop a message back into our own queue.
    listMessageablePeers.mockResolvedValue([
      { ...peer('self', 'self-00', '/w/self'), ipcPath: '/tmp/self.sock' },
      peer('s1', 'app-ab'),
    ]);

    for (const target of [
      'self-00',
      peerRef('self'),
      `self-00 [${peerRef('self')}]`,
    ]) {
      const outcome = await sendToPeer({
        target,
        message: 'hi',
        approvalMode: ApprovalMode.DEFAULT,
      });
      expect(outcome).toEqual({ kind: 'self', name: 'self-00' });
    }
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it("still reaches a peer that happens to share this session's name", async () => {
    listMessageablePeers.mockResolvedValue([
      { ...peer('self', 'self-00', '/w/self'), ipcPath: '/tmp/self.sock' },
      peer('s9', 'self-00', '/w/twin'),
    ]);
    const outcome = await sendToPeer({
      target: 'self-00',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(outcome).toMatchObject({ kind: 'sent', address: 'self-00' });
    expect(sendPeerFrame.mock.calls[0][0]).toBe('/tmp/s9.sock');
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
      expect(outcome.matches[0]).toContain(peerRef('s1'));
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

    expect(outcome).toMatchObject({
      kind: 'sent',
      address: `app-ab [${two.ref}]`,
    });
    expect(sendPeerFrame.mock.calls[0][0]).toBe('/tmp/s2.sock');
    expect(sendPeerFrame.mock.calls[0][1]).toMatchObject({ toSessionId: 's2' });
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
    expect(describeSendFailure(new PeerSendError('x', 'EAGAIN'))).toContain(
      'Retry the same name',
    );
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

describe('lookupSentPeerMessage', () => {
  it('remembers a delivered send under its frame id', async () => {
    const two = peer('s2', 'app-ab', '/w/two');
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab'), two]);
    await sendToPeer({
      target: `app-ab [${two.ref}]`,
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    const frame = sendPeerFrame.mock.calls[0][1];
    expect(lookupSentPeerMessage(frame.msgId)).toMatchObject({
      address: `app-ab [${two.ref}]`,
      peerName: 'app-ab',
    });
    // The same equivalence the receiving gate applies to ids.
    expect(lookupSentPeerMessage(frame.msgId.toUpperCase())).toBeDefined();
  });

  it('does not remember a send that failed', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    sendPeerFrame.mockRejectedValue(new PeerSendError('gone', 'ENOENT'));
    await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(
      lookupSentPeerMessage(sendPeerFrame.mock.calls[0][1].msgId),
    ).toBeUndefined();
  });

  it('answers only for ids this session sent', () => {
    expect(lookupSentPeerMessage('never-sent')).toBeUndefined();
  });

  it('forgets the oldest send past the cap', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    for (let i = 0; i <= MAX_TRACKED_SENDS; i += 1) {
      await sendToPeer({
        target: 'app-ab',
        message: `m${i}`,
        approvalMode: ApprovalMode.DEFAULT,
      });
    }
    const first = sendPeerFrame.mock.calls[0][1].msgId;
    const last = sendPeerFrame.mock.calls.at(-1)![1].msgId;
    expect(lookupSentPeerMessage(first)).toBeUndefined();
    expect(lookupSentPeerMessage(last)).toBeDefined();
  });
});
