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
  settleSentPeerMessage,
} = await import('./peer-send.js');
const { peerRef, resolvePeerTarget } = await import('./peer-directory.js');

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

  it('reports the flattened name peers see, not the raw record', async () => {
    readOwnSessionRecord.mockResolvedValue({
      ...SELF,
      name: 'self\u001b[31m-00',
    });
    expect((await getOwnPeerIdentity())?.name).toBe('self [31m-00');
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

  it('refuses an empty message before building a frame', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    const outcome = await sendToPeer({
      target: 'app-ab',
      message: '',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(outcome).toMatchObject({ kind: 'failed', address: 'app-ab' });
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('empty');
    }
    expect(sendPeerFrame).not.toHaveBeenCalled();
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

  it('explains a timeout as possibly still readable, with a next step', () => {
    const text = describeSendFailure(new PeerSendError('x', 'ETIMEDOUT'));
    expect(text).toContain('may still read it');
    expect(text).toContain('retry once');
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

  it('forgets a send that provably never arrived', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    for (const code of ['ENOENT', 'ECONNREFUSED', 'EMSGSIZE']) {
      sendPeerFrame.mockClear();
      sendPeerFrame.mockRejectedValue(new PeerSendError('gone', code));
      await sendToPeer({
        target: 'app-ab',
        message: 'hi',
        approvalMode: ApprovalMode.DEFAULT,
      });
      expect(
        lookupSentPeerMessage(sendPeerFrame.mock.calls[0][1].msgId),
      ).toBeUndefined();
    }
  });

  it("forgets a send refused by a full backlog or this side's own cap", async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    for (const code of ['EAGAIN', 'EBUSY']) {
      sendPeerFrame.mockClear();
      sendPeerFrame.mockRejectedValue(new PeerSendError('busy', code));
      await sendToPeer({
        target: 'app-ab',
        message: 'hi',
        approvalMode: ApprovalMode.DEFAULT,
      });
      expect(
        lookupSentPeerMessage(sendPeerFrame.mock.calls[0][1].msgId),
      ).toBeUndefined();
    }
  });

  it('reports a reserved bare name as name [ref], in suggestions and on send', async () => {
    const shadowed = peer('s1', 'build');
    listMessageablePeers.mockResolvedValue([shadowed]);
    const isReserved = (address: string) => address === 'build';

    const miss = await sendToPeer({
      target: 'buil',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
      isReserved,
    });
    expect(miss).toEqual({
      kind: 'not-found',
      suggestions: [`build [${shadowed.ref}]`],
    });

    const sent = await sendToPeer({
      target: `build [${shadowed.ref}]`,
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
      isReserved,
    });
    expect(sent).toMatchObject({
      kind: 'sent',
      address: `build [${shadowed.ref}]`,
    });
  });

  it('records an address that re-resolves to the same session', async () => {
    // A teammate reserves the bare name and a second peer carries the
    // literal registry name "docs-cd [aaa111]": only "[aaa111]" selects
    // s1 uniquely, and that is what the ledger must remember.
    const s1 = { ...peer('s1', 'docs-cd'), ref: 'aaa111' };
    const s2 = { ...peer('s2', 'docs-cd [aaa111]', '/w/two'), ref: 'bbb222' };
    listMessageablePeers.mockResolvedValue([s1, s2]);
    const isReserved = (address: string) => address === 'docs-cd';

    const outcome = await sendToPeer({
      target: '[aaa111]',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
      isReserved,
    });
    expect(outcome).toMatchObject({
      kind: 'sent',
      peer: s1,
      address: '[aaa111]',
    });
    expect(resolvePeerTarget([s1, s2], '[aaa111]')).toEqual({
      kind: 'one',
      peer: s1,
    });
    // The ledger half: `peer-messaging` forwards `settled.address` into the
    // notice the sender reads, so recording anything but the round-trippable
    // address re-advertises the reserved bare name and a re-send lands on the
    // teammate instead of this peer.
    expect(
      lookupSentPeerMessage(sendPeerFrame.mock.calls[0][1].msgId),
    ).toMatchObject({
      address: '[aaa111]',
      peerName: 'docs-cd',
      state: 'pending',
    });

    // Same session, spelled with padding the resolver trims: the ledger must
    // record the address that re-resolves, never the caller's raw target.
    await sendToPeer({
      target: '  [aaa111]  ',
      message: 'hi again',
      approvalMode: ApprovalMode.DEFAULT,
      isReserved,
    });
    expect(
      lookupSentPeerMessage(sendPeerFrame.mock.calls[1][1].msgId),
    ).toMatchObject({ address: '[aaa111]' });
  });

  it('keeps a send that timed out, since the peer may still read it', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    sendPeerFrame.mockRejectedValue(new PeerSendError('slow', 'ETIMEDOUT'));
    await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(
      lookupSentPeerMessage(sendPeerFrame.mock.calls[0][1].msgId),
    ).toMatchObject({ address: 'app-ab', state: 'pending' });
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

describe('settleSentPeerMessage', () => {
  async function sendOne(): Promise<string> {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    return sendPeerFrame.mock.calls.at(-1)![1].msgId as string;
  }

  it('reports the first receipt and the state it moved from', async () => {
    const id = await sendOne();
    expect(settleSentPeerMessage(id, 'held')).toEqual({
      address: 'app-ab',
      peerName: 'app-ab',
      previous: 'pending',
    });
    expect(settleSentPeerMessage(id, 'delivered')).toEqual({
      address: 'app-ab',
      peerName: 'app-ab',
      previous: 'held',
    });
  });

  it('drops a repeated receipt', async () => {
    const id = await sendOne();
    expect(settleSentPeerMessage(id, 'held')).toBeDefined();
    expect(settleSentPeerMessage(id, 'held')).toBeUndefined();
    expect(settleSentPeerMessage(id, 'denied')).toBeDefined();
    expect(settleSentPeerMessage(id, 'denied')).toBeUndefined();
    expect(settleSentPeerMessage(id, 'held')).toBeUndefined();
  });

  it('lets a delivery be corrected to expired exactly once', async () => {
    const id = await sendOne();
    expect(settleSentPeerMessage(id, 'delivered')).toBeDefined();
    expect(settleSentPeerMessage(id, 'expired')).toMatchObject({
      previous: 'delivered',
    });
    expect(settleSentPeerMessage(id, 'expired')).toBeUndefined();
    expect(settleSentPeerMessage(id, 'delivered')).toBeUndefined();
  });

  it('lets a delivery be corrected to misaddressed exactly once', async () => {
    const id = await sendOne();
    expect(settleSentPeerMessage(id, 'delivered')).toBeDefined();
    expect(settleSentPeerMessage(id, 'misaddressed')).toMatchObject({
      previous: 'delivered',
    });
    expect(settleSentPeerMessage(id, 'misaddressed')).toBeUndefined();
  });

  it('lets a hold be corrected to expired or misaddressed', async () => {
    for (const next of ['expired', 'misaddressed'] as const) {
      const id = await sendOne();
      expect(settleSentPeerMessage(id, 'held')).toBeDefined();
      expect(settleSentPeerMessage(id, next)).toMatchObject({
        previous: 'held',
      });
      expect(settleSentPeerMessage(id, 'delivered')).toBeUndefined();
    }
  });

  it('treats a terminal state as final', async () => {
    for (const terminal of ['denied', 'expired', 'misaddressed'] as const) {
      const id = await sendOne();
      expect(settleSentPeerMessage(id, terminal)).toBeDefined();
      for (const next of [
        'held',
        'delivered',
        'denied',
        'expired',
        'misaddressed',
      ] as const) {
        expect(settleSentPeerMessage(id, next)).toBeUndefined();
      }
    }
  });

  it('answers only for ids this session sent', () => {
    expect(settleSentPeerMessage('never-sent', 'held')).toBeUndefined();
  });

  it('matches ids the way the receiving gate does', async () => {
    const id = await sendOne();
    expect(settleSentPeerMessage(id.toUpperCase(), 'held')).toBeDefined();
  });
});
