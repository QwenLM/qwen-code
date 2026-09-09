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
  drainSendPacer,
  forgetSendPacerMessages,
  getOwnPeerIdentity,
  lookupSentPeerMessageForTest,
  MAX_TRACKED_SENDS,
  refundSendPacerMessage,
  refundSendPacerToken,
  resetSendPacerForTest,
  resetSentPeerMessagesForTest,
  senderModeClass,
  sendToPeer,
  setSendPacerClockForTest,
  settleSentPeerMessage,
  trackSentPeerMessageForTest,
} = await import('./peer-send.js');
const { PEER_ADMISSION_LIMITS, PEER_BURST_WINDOW_MS } = await import(
  './peer-admission.js'
);
const { advertisablePeerAddress, peerRef, resolvePeerTarget } = await import(
  './peer-directory.js'
);

function peer(
  sessionId: string,
  name: string,
  cwd = '/w/app',
  // Overridable so a test can stage the one shape the derived ref cannot
  // produce: two live sessions whose 6-hex refs collide.
  ref = peerRef(sessionId),
) {
  return {
    sessionId,
    name,
    ref,
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
  // The mirror buckets are process-global like the ledger, so a test that
  // sends a lot would otherwise pace the one after it.
  resetSendPacerForTest();
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

  it('authenticates with the target token and offers its own for receipts', async () => {
    readOwnSessionRecord.mockResolvedValue({ ...SELF, ipcToken: 'own-token' });
    listMessageablePeers.mockResolvedValue([
      { ...peer('s1', 'app-ab'), ipcToken: 'target-token' },
    ]);

    await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });

    const [, frame, options] = sendPeerFrame.mock.calls[0];
    expect(frame).toMatchObject({ replyToken: 'own-token' });
    expect(options).toEqual({ authToken: 'target-token' });
  });

  it('omits tokens for records written before tokens existed', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);

    await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });

    const [, frame, options] = sendPeerFrame.mock.calls[0];
    expect(frame).not.toHaveProperty('replyToken');
    expect(options).toEqual({});
  });

  it('asserts bypass when this session no longer reviews its actions', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    for (const mode of [
      ApprovalMode.YOLO,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.AUTO,
    ]) {
      sendPeerFrame.mockClear();
      await sendToPeer({
        target: 'app-ab',
        message: `hi in ${mode}`,
        approvalMode: mode,
      });
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

  it('treats a differently named twin of this session as itself', async () => {
    // `qwen --resume <id>` from another directory runs this very session
    // id under a second process with another name. Its inbound gate would
    // accept a frame pinned to the shared id, so it must not be reachable.
    listMessageablePeers.mockResolvedValue([
      { ...peer('self', 'self-old', '/w/old'), ipcPath: '/tmp/old.sock' },
      peer('s1', 'app-ab'),
    ]);
    const outcome = await sendToPeer({
      target: 'self-old',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(outcome).toEqual({ kind: 'self', name: 'self-00' });
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('never suggests a twin of this session as a near miss', async () => {
    listMessageablePeers.mockResolvedValue([
      { ...peer('self', 'self-old', '/w/old'), ipcPath: '/tmp/old.sock' },
    ]);
    const outcome = await sendToPeer({
      target: 'self-ol',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(outcome).toEqual({ kind: 'not-found', suggestions: [] });
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
    expect(text).toContain('do not assume it was lost or resend');
    expect(text).toContain('wait for a delivery receipt');
  });

  it('falls back to the message for anything else', () => {
    expect(describeSendFailure(new PeerSendError('weird', 'EWEIRD'))).toBe(
      'weird',
    );
    expect(describeSendFailure(new Error('plain'))).toBe('plain');
    expect(describeSendFailure('a string')).toBe('a string');
  });
});

describe('lookupSentPeerMessageForTest', () => {
  it('remembers a delivered send under its frame id', async () => {
    const two = peer('s2', 'app-ab', '/w/two');
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab'), two]);
    await sendToPeer({
      target: `app-ab [${two.ref}]`,
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });
    const frame = sendPeerFrame.mock.calls[0][1];
    expect(lookupSentPeerMessageForTest(frame.msgId)).toMatchObject({
      address: `app-ab [${two.ref}]`,
    });
    // The same equivalence the receiving gate applies to ids.
    expect(
      lookupSentPeerMessageForTest(frame.msgId.toUpperCase()),
    ).toBeDefined();
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
        lookupSentPeerMessageForTest(sendPeerFrame.mock.calls[0][1].msgId),
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
        lookupSentPeerMessageForTest(sendPeerFrame.mock.calls[0][1].msgId),
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
      lookupSentPeerMessageForTest(sendPeerFrame.mock.calls[0][1].msgId),
    ).toMatchObject({
      address: '[aaa111]',
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
      lookupSentPeerMessageForTest(sendPeerFrame.mock.calls[1][1].msgId),
    ).toMatchObject({ address: '[aaa111]' });
  });

  it("records the caller's own target when no address can be advertised", async () => {
    // Every advertisable form for `docs` is taken: the bare name by the
    // caller's in-process routing, and both bracketed forms by sessions
    // carrying those exact strings as literal names (registry names are
    // other-process input and may contain brackets).
    const docs = peer('s1', 'docs', '/w/one', 'aaa111');
    const bracketedName = peer('s2', 'docs [aaa111]', '/w/two', 'bbb222');
    const bareName = peer('s3', '[aaa111]', '/w/three', 'ccc333');
    const all = [docs, bracketedName, bareName];
    listMessageablePeers.mockResolvedValue(all);
    const isReserved = (address: string) => address === 'docs';
    expect(advertisablePeerAddress(docs, all, isReserved)).toBeUndefined();

    const outcome = await sendToPeer({
      target: 'aaa111',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
      isReserved,
    });

    expect(outcome).toMatchObject({
      kind: 'sent',
      peer: docs,
      address: 'aaa111',
    });
    // The synthesized `[aaa111]` this used to fall back to is precisely a
    // form `advertisablePeerAddress` had already rejected: it resolves to
    // two sessions, so a receipt naming it walked the model back into the
    // ambiguous branch. The caller's own target has no such problem — it
    // just resolved uniquely to this peer.
    expect(resolvePeerTarget(all, 'aaa111')).toEqual({
      kind: 'one',
      peer: docs,
    });
    expect(resolvePeerTarget(all, '[aaa111]').kind).toBe('ambiguous');
    expect(
      lookupSentPeerMessageForTest(sendPeerFrame.mock.calls[0][1].msgId),
    ).toMatchObject({ address: 'aaa111', state: 'pending' });
  });

  it('says so when no address distinguishes an ambiguous pair', async () => {
    // One name over a 6-hex ref collision. Both sessions print the same
    // `name [ref]`, so listing it twice hands the caller one string and the
    // advice to "re-send with the full name [ref]" cannot be followed.
    const twinA = peer('s1', 'app-ab', '/w/one', 'abc123');
    const twinB = peer('s2', 'app-ab', '/w/two', 'abc123');
    listMessageablePeers.mockResolvedValue([twinA, twinB]);

    const outcome = await sendToPeer({
      target: 'app-ab',
      message: 'hi',
      approvalMode: ApprovalMode.DEFAULT,
    });

    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.matches).toHaveLength(2);
      for (const line of outcome.matches) {
        expect(line).toContain('no address reaches this one');
      }
      expect(outcome.matches[0]).toContain('/w/one');
      expect(outcome.matches[1]).toContain('/w/two');
    }
    expect(sendPeerFrame).not.toHaveBeenCalled();
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
      lookupSentPeerMessageForTest(sendPeerFrame.mock.calls[0][1].msgId),
    ).toMatchObject({ address: 'app-ab', state: 'pending' });
  });

  it('answers only for ids this session sent', () => {
    expect(lookupSentPeerMessageForTest('never-sent')).toBeUndefined();
  });

  it('forgets the oldest send past the cap', async () => {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    for (let i = 0; i <= MAX_TRACKED_SENDS; i += 1) {
      // Two hundred sends to one target is far past what its mirror
      // bucket allows in a burst; this case is about the ledger's own
      // cap, so the pacer is kept out of the way.
      resetSendPacerForTest();
      await sendToPeer({
        target: 'app-ab',
        message: `m${i}`,
        approvalMode: ApprovalMode.DEFAULT,
      });
    }
    const first = sendPeerFrame.mock.calls[0][1].msgId;
    const last = sendPeerFrame.mock.calls.at(-1)![1].msgId;
    expect(lookupSentPeerMessageForTest(first)).toBeUndefined();
    expect(lookupSentPeerMessageForTest(last)).toBeDefined();
  });
});

describe('settleSentPeerMessage', () => {
  // A distinct body each time: the mirror refuses a verbatim repeat to
  // one target inside the receiver's dedup window, and these cases are
  // about the ledger rather than about that.
  let sendCounter = 0;
  async function sendOne(): Promise<string> {
    listMessageablePeers.mockResolvedValue([peer('s1', 'app-ab')]);
    sendCounter += 1;
    await sendToPeer({
      target: 'app-ab',
      message: `hi ${sendCounter}`,
      approvalMode: ApprovalMode.DEFAULT,
    });
    return sendPeerFrame.mock.calls.at(-1)![1].msgId as string;
  }

  it('reports the first receipt and the state it moved from', async () => {
    const id = await sendOne();
    expect(settleSentPeerMessage(id, 'held')).toEqual({
      address: 'app-ab',
      ageMs: expect.any(Number),
      ipcPath: '/tmp/s1.sock',
      previous: 'pending',
    });
    expect(settleSentPeerMessage(id, 'delivered')).toEqual({
      address: 'app-ab',
      ageMs: expect.any(Number),
      ipcPath: '/tmp/s1.sock',
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

  it('reports a refusal, and only from pending', async () => {
    const id = await sendOne();
    expect(settleSentPeerMessage(id, 'refused')).toMatchObject({
      previous: 'pending',
    });

    // A message already parked was not turned away, so a 'refused'
    // receipt after a hold is a peer contradicting itself.
    const held = await sendOne();
    expect(settleSentPeerMessage(held, 'held')).toBeDefined();
    expect(settleSentPeerMessage(held, 'refused')).toBeUndefined();

    // Nor after delivery. Any process that can reach this session's
    // socket can write a receipt for any id, so a contradicting peer
    // must not be able to flip a delivered message into "does not accept
    // messages -- don't re-send it" and have the model abandon a send
    // the recipient already has.
    const delivered = await sendOne();
    expect(settleSentPeerMessage(delivered, 'delivered')).toBeDefined();
    expect(settleSentPeerMessage(delivered, 'refused')).toBeUndefined();
  });

  it('treats a terminal state as final', async () => {
    for (const terminal of [
      'denied',
      'refused',
      'expired',
      'misaddressed',
    ] as const) {
      const id = await sendOne();
      expect(settleSentPeerMessage(id, terminal)).toBeDefined();
      for (const next of [
        'held',
        'delivered',
        'denied',
        'refused',
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

describe('sender-side pacing', () => {
  const target = peer('p1', 'app-a');

  beforeEach(() => {
    listMessageablePeers.mockResolvedValue([target]);
  });

  async function send(message: string) {
    return sendToPeer({
      target: 'app-a',
      message,
      approvalMode: ApprovalMode.DEFAULT,
    });
  }

  it('refuses the send that would be dropped, and says what to do instead', async () => {
    for (let index = 0; index < PEER_ADMISSION_LIMITS.bucketCapacity; index++) {
      expect((await send(`message ${index}`)).kind).toBe('sent');
    }

    const refused = await send('one too many');
    expect(refused.kind).toBe('failed');
    expect(refused.kind === 'failed' && refused.reason).toContain(
      `${PEER_ADMISSION_LIMITS.bucketCapacity} were sent`,
    );
    expect(refused.kind === 'failed' && refused.reason).toContain(
      'Batch what remains into one message',
    );
  });

  it('does not write, or remember, a send it refused', async () => {
    // The ledger half matters as much as the write: a refused send left
    // in it would sit `pending` forever, and evict a real send whose
    // receipt still needs its slot.
    for (let index = 0; index < PEER_ADMISSION_LIMITS.bucketCapacity; index++) {
      await send(`message ${index}`);
    }
    const writes = sendPeerFrame.mock.calls.length;
    const lastRealId = sendPeerFrame.mock.calls.at(-1)![1].msgId as string;

    await send('one too many');
    // No frame, so no id, so nothing for a receipt to answer for.
    expect(sendPeerFrame.mock.calls).toHaveLength(writes);
    // And the ledger is untouched: the last thing in it is still the last
    // send that really happened.
    expect(lookupSentPeerMessageForTest(lastRealId)).toBeDefined();
    expect(
      sendPeerFrame.mock.calls.filter(
        (call: unknown[]) =>
          ((call[1] as { message: { content: string } }).message.content ??
            '') === 'one too many',
      ),
    ).toHaveLength(0);
  });

  it('gives the token back when the frame provably never left', async () => {
    // Leave one token so the failing send actually reaches the socket.
    for (
      let index = 0;
      index < PEER_ADMISSION_LIMITS.bucketCapacity - 1;
      index++
    ) {
      await send(`message ${index}`);
    }
    // Spend nothing: this one never reached the peer.
    sendPeerFrame.mockRejectedValueOnce(
      new PeerSendError('gone', 'ECONNREFUSED'),
    );
    expect((await send('never arrived')).kind).toBe('failed');

    sendPeerFrame.mockResolvedValue(undefined);
    // The refund bought the token back, so the next send is written.
    expect((await send('next one')).kind).toBe('sent');
  });

  it('keeps the token spent when the frame may still arrive', async () => {
    for (
      let index = 0;
      index < PEER_ADMISSION_LIMITS.bucketCapacity - 1;
      index++
    ) {
      await send(`message ${index}`);
    }
    // A timeout proves nothing: the peer may read the bytes once it is
    // free, so the token stays spent.
    sendPeerFrame.mockRejectedValueOnce(new PeerSendError('slow', 'ETIMEDOUT'));
    expect((await send('maybe arrived')).kind).toBe('failed');

    sendPeerFrame.mockResolvedValue(undefined);
    expect((await send('next one')).kind).toBe('failed');
  });

  it('reports a repeat when the body and token limits both bind', async () => {
    let lastBody = '';
    for (let index = 0; index < PEER_ADMISSION_LIMITS.bucketCapacity; index++) {
      lastBody = `message ${index}`;
      await send(lastBody);
    }

    const refused = await send(lastBody);

    expect(refused.kind).toBe('failed');
    expect(refused.kind === 'failed' && refused.reason).toContain(
      'turns away a repeat',
    );
  });

  it('keeps a separate mirror per target', async () => {
    const other = peer('p2', 'app-b');
    listMessageablePeers.mockResolvedValue([target, other]);
    for (let index = 0; index < PEER_ADMISSION_LIMITS.bucketCapacity; index++) {
      await send(`message ${index}`);
    }
    expect((await send('one too many')).kind).toBe('failed');

    // A quiet peer is not paced by a noisy one.
    const toOther = await sendToPeer({
      target: 'app-b',
      message: 'hello',
      approvalMode: ApprovalMode.DEFAULT,
    });
    expect(toOther.kind).toBe('sent');
  });

  it('empties the mirror when the receiver says it was already over', async () => {
    expect((await send('first')).kind).toBe('sent');
    // Other senders share that bucket, so the receiver is the authority.
    drainSendPacer(target.ipcPath);
    const refused = await send('second');
    expect(refused.kind).toBe('failed');
    // One real send, not a full bucket: the drain is the receiver's
    // level, so the count the refusal quotes stays this session's own.
    expect(refused.kind === 'failed' && refused.reason).toContain(
      '1 were sent',
    );
    expect(refused.kind === 'failed' && refused.reason).not.toContain(
      `${PEER_ADMISSION_LIMITS.bucketCapacity} were sent`,
    );
  });

  it('a refusal late in a burst quotes the count that emptied the bucket', async () => {
    let clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      expect((await send('first')).kind).toBe('sent');
      drainSendPacer(target.ipcPath);
      // Sending at the refill rate keeps the bucket empty: odd seconds
      // refuse, even seconds spend the token that just grew back. Once a
      // refusal lands past the burst window it must still quote the
      // window that emptied the bucket, not a fresh zeroed one.
      let lateRefusal: Awaited<ReturnType<typeof send>> | undefined;
      for (
        let seconds = 1;
        seconds <= PEER_BURST_WINDOW_MS / 1000 + 1;
        seconds++
      ) {
        clock += 1000;
        const outcome = await send(`paced ${seconds}`);
        if (clock > PEER_BURST_WINDOW_MS && outcome.kind === 'failed') {
          lateRefusal = outcome;
          break;
        }
      }
      expect(lateRefusal).toBeDefined();
      expect(lateRefusal!.kind === 'failed' && lateRefusal!.reason).toContain(
        '31 were sent',
      );
      expect(
        lateRefusal!.kind === 'failed' && lateRefusal!.reason,
      ).not.toContain(': 0 were sent');
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('refills the mirror once the burst window has passed', async () => {
    let clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      for (
        let index = 0;
        index < PEER_ADMISSION_LIMITS.bucketCapacity;
        index++
      ) {
        expect((await send(`message ${index}`)).kind).toBe('sent');
      }
      expect((await send('one too many')).kind).toBe('failed');

      clock += PEER_BURST_WINDOW_MS + 1;
      expect((await send('after the window')).kind).toBe('sent');
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('refuses a repeat the receiver would drop, without writing it', async () => {
    // The mirror knows the receiver remembers this exact body and will
    // turn it away before policy, so writing it would spend a connection
    // there and tell the caller "sent" for a message nobody reads.
    expect((await send('stuck on this')).kind).toBe('sent');
    const writes = sendPeerFrame.mock.calls.length;

    const repeat = await send('stuck on this');
    expect(repeat.kind).toBe('failed');
    expect(repeat.kind === 'failed' && repeat.reason).toContain(
      'turns away a repeat',
    );
    expect(sendPeerFrame.mock.calls).toHaveLength(writes);
  });

  it('does not charge the mirror for a repeat it refused', async () => {
    // The refusal costs no token, or a model looping on one body would
    // drain the mirror below the receiver's real bucket and then be
    // refused its first genuinely different message.
    expect((await send('stuck on this')).kind).toBe('sent');
    for (let index = 0; index < 40; index++) {
      expect((await send('stuck on this')).kind).toBe('failed');
    }
    for (
      let index = 0;
      index < PEER_ADMISSION_LIMITS.bucketCapacity - 1;
      index++
    ) {
      expect((await send(`different ${index}`)).kind).toBe('sent');
    }
    expect((await send('one too many')).kind).toBe('failed');
  });

  it('lets the same body through once the receiver has forgotten it', async () => {
    let clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      expect((await send('say it again')).kind).toBe('sent');
      expect((await send('say it again')).kind).toBe('failed');
      clock += PEER_ADMISSION_LIMITS.dedupWindowMs + 1;
      expect((await send('say it again')).kind).toBe('sent');
    } finally {
      setSendPacerClockForTest();
    }
  });
});

describe('dropped receipts on the send side', () => {
  it('settles a pending message', () => {
    trackSentPeerMessageForTest('sent-1', 'app-a');
    expect(settleSentPeerMessage('sent-1', 'dropped')).toEqual({
      address: 'app-a',
      ageMs: expect.any(Number),
      ipcPath: 'app-a',
      previous: 'pending',
    });
  });

  it('does not un-hold a message that was already parked', () => {
    // A drop is decided before the message is anything to the receiver,
    // so one naming a held message is answering a later frame that reused
    // the id — applying it would say a delivered message never arrived.
    trackSentPeerMessageForTest('sent-2', 'app-a');
    settleSentPeerMessage('sent-2', 'held');
    expect(settleSentPeerMessage('sent-2', 'dropped')).toBeUndefined();
  });

  it('does not un-deliver a message that already landed', () => {
    trackSentPeerMessageForTest('sent-3', 'app-a');
    settleSentPeerMessage('sent-3', 'delivered');
    expect(settleSentPeerMessage('sent-3', 'dropped')).toBeUndefined();
  });

  it('is terminal', () => {
    trackSentPeerMessageForTest('sent-4', 'app-a');
    settleSentPeerMessage('sent-4', 'dropped');
    expect(settleSentPeerMessage('sent-4', 'expired')).toBeUndefined();
  });

  it('answers for nothing a stranger names', () => {
    expect(settleSentPeerMessage('never-sent', 'dropped')).toBeUndefined();
  });
});

describe('the mirror and the receiver disagreeing', () => {
  const target = peer('p1', 'app-a');

  beforeEach(() => {
    listMessageablePeers.mockResolvedValue([target]);
  });

  async function send(message: string) {
    return sendToPeer({
      target: 'app-a',
      message,
      approvalMode: ApprovalMode.DEFAULT,
    });
  }

  it('ages repeat records across a system suspend like the receiver', async () => {
    const monotonic = 0;
    let wall = 0;
    setSendPacerClockForTest(
      () => monotonic,
      () => wall,
    );
    try {
      expect((await send('same body')).kind).toBe('sent');
      wall += PEER_ADMISSION_LIMITS.dedupWindowMs + 1;
      expect((await send('same body')).kind).toBe('sent');
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('starts a fresh mirror conversation when the session id changes', async () => {
    expect((await send('same body')).kind).toBe('sent');
    listMessageablePeers.mockResolvedValue([
      { ...target, sessionId: 'p2', ref: peerRef('p2') },
    ]);

    expect((await send('same body')).kind).toBe('sent');
  });

  it('does not un-drain the mirror with a refund that lands after the drain', async () => {
    // The drain is the receiver's own word on its level. A refund from a
    // send that was in flight at the time must not quietly restore the
    // token it just took away.
    const clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      expect((await send('first')).kind).toBe('sent');
      let failing: (() => void) | undefined;
      sendPeerFrame.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failing = () => reject(new PeerSendError('gone', 'ECONNREFUSED'));
          }),
      );
      const inFlight = send('second');
      // The receiver answers an earlier message while this one is still
      // on the wire.
      drainSendPacer(target.ipcPath);
      failing?.();
      expect((await inFlight).kind).toBe('failed');

      sendPeerFrame.mockResolvedValue(undefined);
      expect((await send('third')).kind).toBe('failed');
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('does not quote a zero-message burst after a drain races a refund', async () => {
    const clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      let fail: (() => void) | undefined;
      sendPeerFrame.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = () => reject(new PeerSendError('gone', 'ECONNREFUSED'));
          }),
      );
      const inFlight = send('never arrived');
      await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
      drainSendPacer(target.ipcPath);
      fail?.();
      await inFlight;

      sendPeerFrame.mockResolvedValue(undefined);
      const refused = await send('next body');
      expect(refused.kind).toBe('failed');
      expect(refused.kind === 'failed' && refused.reason).not.toContain(
        ': 0 were sent',
      );
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('keeps uncertain reset writes in the ledger and repeat baseline', async () => {
    sendPeerFrame.mockRejectedValueOnce(
      new PeerSendError('reset after connect', 'ECONNRESET'),
    );
    expect((await send('maybe arrived')).kind).toBe('failed');
    const id = sendPeerFrame.mock.calls[0]?.[1].msgId as string;
    expect(lookupSentPeerMessageForTest(id)).toBeDefined();

    sendPeerFrame.mockResolvedValue(undefined);
    const retry = await send('maybe arrived');
    expect(retry.kind).toBe('failed');
    expect(retry.kind === 'failed' && retry.reason).toContain(
      'turns away a repeat',
    );
    expect(sendPeerFrame).toHaveBeenCalledTimes(1);
  });

  it('restores the body the receiver still remembers when a send is refunded', async () => {
    // Clearing the record instead would make the next send of the earlier
    // body cost a token here while the receiver drops it for free — the
    // mirror drifting below the real bucket, which it must never do.
    const clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      expect((await send('A')).kind).toBe('sent');
      sendPeerFrame.mockRejectedValueOnce(new PeerSendError('busy', 'EAGAIN'));
      expect((await send('C')).kind).toBe('failed');
      sendPeerFrame.mockResolvedValue(undefined);

      // The receiver never saw C, and still remembers A.
      const retryA = await send('A');
      expect(retryA.kind).toBe('failed');
      expect(retryA.kind === 'failed' && retryA.reason).toContain(
        'turns away a repeat',
      );
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('forgets a body the receiver reports as undelivered', async () => {
    const clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      expect((await send('A')).kind).toBe('sent');
      expect((await send('B')).kind).toBe('sent');
      const droppedId = sendPeerFrame.mock.calls[1]?.[1].msgId as string;

      forgetSendPacerMessages(target.ipcPath, [droppedId]);

      const repeatA = await send('A');
      expect(repeatA.kind).toBe('failed');
      expect(repeatA.kind === 'failed' && repeatA.reason).toContain(
        'turns away a repeat',
      );
      expect((await send('B')).kind).toBe('sent');
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('refunds the token for a message rejected before admission', async () => {
    const clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      for (let i = 0; i < PEER_ADMISSION_LIMITS.bucketCapacity; i += 1) {
        expect((await send(`body ${i}`)).kind).toBe('sent');
      }
      const firstId = sendPeerFrame.mock.calls[0]?.[1].msgId as string;
      expect((await send('over capacity')).kind).toBe('failed');

      refundSendPacerMessage(target.ipcPath, firstId);

      expect((await send('after misaddressed')).kind).toBe('sent');
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('refunds a duplicate token without forgetting its body', async () => {
    const clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      for (let i = 0; i < PEER_ADMISSION_LIMITS.bucketCapacity; i += 1) {
        expect((await send(`body ${i}`)).kind).toBe('sent');
      }
      const lastId = sendPeerFrame.mock.calls.at(-1)?.[1].msgId as string;
      refundSendPacerToken(target.ipcPath, lastId);

      const repeat = await send(
        `body ${PEER_ADMISSION_LIMITS.bucketCapacity - 1}`,
      );
      expect(repeat.kind).toBe('failed');
      expect(repeat.kind === 'failed' && repeat.reason).toContain(
        'turns away a repeat',
      );
      expect((await send('different body')).kind).toBe('sent');
    } finally {
      setSendPacerClockForTest();
    }
  });

  it('does not invent a mirror for a target it never paced', async () => {
    // A receipt can name any address. Minting an empty bucket for one
    // nothing was sent to would refuse the first real send there, quoting
    // a burst of zero.
    drainSendPacer('/tmp/never-used.sock');
    expect((await send('hello')).kind).toBe('sent');
  });

  it('keeps the burst count bounded by the window, not by the session', async () => {
    // A drain corrects the level; it is not the start of a new burst.
    // Re-anchoring the window on every receipt would stop it ever
    // rolling, so the count a refusal quotes as "in the last minute"
    // would grow for as long as the session lives.
    let clock = 0;
    setSendPacerClockForTest(() => clock);
    try {
      const perWindow =
        (PEER_BURST_WINDOW_MS / 1000) * PEER_ADMISSION_LIMITS.refillPerSecond;
      for (let step = 0; step < PEER_BURST_WINDOW_MS / 1000 + 60; step += 2) {
        clock += 2000;
        await send(`paced ${step}`);
        drainSendPacer(target.ipcPath);
      }
      clock += 1;
      const refusal = await send('one more');
      expect(refusal.kind).toBe('failed');
      const quoted = Number(
        /: (\d+) were sent/.exec(
          refusal.kind === 'failed' ? refusal.reason : '',
        )?.[1] ?? '-1',
      );
      expect(quoted).toBeGreaterThanOrEqual(0);
      expect(quoted).toBeLessThanOrEqual(perWindow + 1);
    } finally {
      setSendPacerClockForTest();
    }
  });
});
