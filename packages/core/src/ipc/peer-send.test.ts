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

vi.mock('../services/session-registry.js', async () => ({
  ...(await vi.importActual<typeof import('../services/session-registry.js')>(
    '../services/session-registry.js',
  )),
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
    kind: 'tui',
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

type Outcome = Awaited<ReturnType<typeof sendToPeer>>;
const settle = settleSentPeerMessage;
type State = Parameters<typeof settle>[1];
const CAP = PEER_ADMISSION_LIMITS.bucketCapacity;

/** A DEFAULT-mode send; `extra` overrides or adds any other option. */
function sendTo(
  target: string,
  message = 'hi',
  extra: Partial<Parameters<typeof sendToPeer>[0]> = {},
) {
  return sendToPeer({
    target,
    message,
    approvalMode: ApprovalMode.DEFAULT,
    ...extra,
  });
}

function peers(...list: unknown[]): void {
  listMessageablePeers.mockResolvedValue(list);
}

const SENT = (address: string) => ({ kind: 'sent', address });
const NOT_FOUND = (...suggestions: string[]) => ({
  kind: 'not-found',
  suggestions,
});
/** The frame of the `index`th socket write, and the ledger entry for its id. */
const frameAt = (index = 0) => sendPeerFrame.mock.calls.at(index)![1];
const ledgerAt = (index = 0) =>
  lookupSentPeerMessageForTest(frameAt(index).msgId);
const reasonOf = (outcome: Outcome) =>
  outcome.kind === 'failed' && outcome.reason;

function expectRefused(outcome: Outcome, ...texts: string[]) {
  expect(outcome.kind).toBe('failed');
  for (const text of texts) expect(reasonOf(outcome)).toContain(text);
}

function receipt(
  previous: string,
  address = 'app-ab',
  ipcPath = '/tmp/s1.sock',
) {
  return { address, ageMs: expect.any(Number), ipcPath, previous };
}

/** The target both pacing describes send to, and a send of one body to it. */
const PACED = peer('p1', 'app-a');
const send = (message: string) => sendTo('app-a', message);

/** Sends `${prefix} ${i}` for each i < count; `check` asserts each was sent. */
async function burst(
  count: number,
  prefix = 'message',
  check = false,
  target = 'app-a',
) {
  for (let i = 0; i < count; i++) {
    const outcome = await sendTo(target, `${prefix} ${i}`);
    if (check) expect(outcome.kind).toBe('sent');
  }
}

/** Runs `body` on a pacer clock it advances by hand, then restores the real one. */
async function withClock(
  body: (advance: (ms: number) => number) => Promise<void>,
) {
  let clock = 0;
  setSendPacerClockForTest(() => clock);
  try {
    await body((ms) => (clock += ms));
  } finally {
    setSendPacerClockForTest();
  }
}

/** Makes the next write hang until `fail()` rejects it as ECONNREFUSED. */
function stallNextWrite() {
  const stalled: { fail?: () => void } = {};
  sendPeerFrame.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        stalled.fail = () => reject(new PeerSendError('gone', 'ECONNREFUSED'));
      }),
  );
  return stalled;
}

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
  const IS_SELF = { kind: 'self', name: 'self-00' };

  it('reports disabled when this session has no inbox', async () => {
    readOwnSessionRecord.mockResolvedValue({ ...SELF, ipcPath: undefined });
    expect(await sendTo('app-ab')).toEqual({ kind: 'disabled' });
    expect(listMessageablePeers).not.toHaveBeenCalled();
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('delivers to a uniquely named peer, pinned to its session id', async () => {
    peers(peer('s1', 'app-ab'));
    const outcome = await sendTo('app-ab', 'check the tests');
    expect(outcome).toMatchObject(SENT('app-ab'));
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
    peers({ ...peer('s1', 'app-ab'), ipcToken: 'target-token' });
    await sendTo('app-ab');
    const [, frame, options] = sendPeerFrame.mock.calls[0];
    expect(frame).toMatchObject({ replyToken: 'own-token' });
    expect(options).toEqual({ authToken: 'target-token' });
  });

  it('omits tokens for records written before tokens existed', async () => {
    peers(peer('s1', 'app-ab'));
    await sendTo('app-ab');
    const [, frame, options] = sendPeerFrame.mock.calls[0];
    expect(frame).not.toHaveProperty('replyToken');
    expect(options).toEqual({});
  });

  it('asserts bypass when this session no longer reviews its actions', async () => {
    peers(peer('s1', 'app-ab'));
    for (const mode of [
      ApprovalMode.YOLO,
      ApprovalMode.AUTO_EDIT,
      ApprovalMode.AUTO,
    ]) {
      sendPeerFrame.mockClear();
      await sendTo('app-ab', `hi in ${mode}`, { approvalMode: mode });
      expect(frameAt()).toMatchObject({ fromMode: 'bypass' });
    }
  });

  it('asserts nothing when the mode is unknown, rather than claiming parity', async () => {
    peers(peer('s1', 'app-ab'));
    await sendTo('app-ab', 'hi', { approvalMode: null });
    expect(frameAt()).not.toHaveProperty('fromMode');
  });

  it('names the mistake when the target is this session itself', async () => {
    // A record for this very session appears in the directory; sending
    // to it would loop a message back into our own queue.
    peers(peer('self', 'self-00', '/w/self'), peer('s1', 'app-ab'));
    const ref = peerRef('self');
    for (const target of ['self-00', ref, `self-00 [${ref}]`]) {
      expect(await sendTo(target)).toEqual(IS_SELF);
    }
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it("delivers to a sibling session that shares this session's inbox", async () => {
    // A process hosting several sessions binds one inbox for all of
    // them, so a sibling's reply address is this session's own. It is
    // still a different session with its own id — excluding by address
    // would hide every sibling of the sending session from it.
    peers({ ...peer('sibling', 'app-ab'), ipcPath: '/tmp/self.sock' });
    expect(await sendTo('app-ab')).toMatchObject(SENT('app-ab'));
    const [socketPath, frame] = sendPeerFrame.mock.calls[0];
    expect(socketPath).toBe('/tmp/self.sock');
    expect(frame.toSessionId).toBe('sibling');
  });

  it("re-reads a peer on this session's own inbox before believing it a sibling", async () => {
    // A patch to this session's own record — a /clear re-id, or the
    // re-assert a misaddressed inbound frame triggers — can land between
    // the own-record read and the directory read, and the stale id
    // filter then keeps this session's own record under its new id.
    // The address does not move on a re-id, so the entry is checked
    // against a fresh read before it is believed to be a sibling.
    readOwnSessionRecord.mockResolvedValueOnce({ ...SELF, sessionId: 's1' });
    readOwnSessionRecord.mockResolvedValue({ ...SELF, sessionId: 's2' });
    peers({ ...peer('s2', 'self-00', '/w/self'), ipcPath: '/tmp/self.sock' });
    expect(await sendTo('self-00')).toEqual(IS_SELF);
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('treats a differently named twin of this session as itself', async () => {
    // `qwen --resume <id>` from another directory runs this very session
    // id under a second process with another name. Its inbound gate would
    // accept a frame pinned to the shared id, so it must not be reachable.
    peers(
      { ...peer('self', 'self-old', '/w/old'), ipcPath: '/tmp/old.sock' },
      peer('s1', 'app-ab'),
    );
    expect(await sendTo('self-old')).toEqual(IS_SELF);
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('never suggests a twin of this session as a near miss', async () => {
    peers({ ...peer('self', 'self-old', '/w/old'), ipcPath: '/tmp/old.sock' });
    expect(await sendTo('self-ol')).toEqual(NOT_FOUND());
  });

  it("still reaches a peer that happens to share this session's name", async () => {
    peers(peer('self', 'self-00', '/w/self'), peer('s9', 'self-00', '/w/twin'));
    expect(await sendTo('self-00')).toMatchObject(SENT('self-00'));
    expect(sendPeerFrame.mock.calls[0][0]).toBe('/tmp/s9.sock');
  });

  it('refuses an ambiguous name and lists the candidates', async () => {
    peers(peer('s1', 'app-ab', '/w/one'), peer('s2', 'app-ab', '/w/two'));
    const outcome = await sendTo('app-ab');
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') {
      expect(outcome.matches).toHaveLength(2);
      expect(outcome.matches[0]).toContain('/w/one');
      expect(outcome.matches[0]).toContain(peerRef('s1'));
    }
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('delivers to the one named by "name [ref]"', async () => {
    const two = peer('s2', 'app-ab', '/w/two');
    peers(peer('s1', 'app-ab', '/w/one'), two);
    const address = `app-ab [${two.ref}]`;
    expect(await sendTo(address)).toMatchObject(SENT(address));
    expect(sendPeerFrame.mock.calls[0][0]).toBe('/tmp/s2.sock');
    expect(frameAt()).toMatchObject({ toSessionId: 's2' });
  });

  it('suggests near-misses when the name is unknown', async () => {
    peers(peer('s1', 'qwen-code-f7'));
    expect(await sendTo('qwen-code')).toEqual(NOT_FOUND('qwen-code-f7'));
  });

  it('refuses an empty message before building a frame', async () => {
    peers(peer('s1', 'app-ab'));
    const outcome = await sendTo('app-ab', '');
    expect(outcome).toMatchObject({ kind: 'failed', address: 'app-ab' });
    expect(reasonOf(outcome)).toContain('empty');
    expect(sendPeerFrame).not.toHaveBeenCalled();
  });

  it('reports a send failure against the address it tried', async () => {
    peers(peer('s1', 'app-ab'));
    sendPeerFrame.mockRejectedValue(new PeerSendError('gone', 'ECONNREFUSED'));
    const outcome = await sendTo('app-ab');
    expect(outcome).toMatchObject({ kind: 'failed', address: 'app-ab' });
    expect(reasonOf(outcome)).toContain('stale');
  });
});

describe('describeSendFailure', () => {
  it('tells a stale address apart from a busy one', () => {
    for (const [code, text] of [
      ['ENOENT', 'stale'],
      ['ECONNREFUSED', 'stale'],
      ['EAGAIN', 'Retry the same name'],
      ['EBUSY', 'Retry the same name'],
    ]) {
      expect(describeSendFailure(new PeerSendError('x', code))).toContain(text);
    }
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
    peers(peer('s1', 'app-ab'), two);
    await sendTo(`app-ab [${two.ref}]`);
    const { msgId } = frameAt();
    expect(lookupSentPeerMessageForTest(msgId)).toMatchObject({
      address: `app-ab [${two.ref}]`,
    });
    // The same equivalence the receiving gate applies to ids.
    expect(lookupSentPeerMessageForTest(msgId.toUpperCase())).toBeDefined();
  });

  /** Each send failing with one of `codes` must leave nothing in the ledger. */
  async function expectForgotten(reason: string, codes: string[]) {
    peers(peer('s1', 'app-ab'));
    for (const code of codes) {
      sendPeerFrame.mockClear();
      sendPeerFrame.mockRejectedValue(new PeerSendError(reason, code));
      await sendTo('app-ab');
      expect(ledgerAt()).toBeUndefined();
    }
  }

  it('forgets a send that provably never arrived', () =>
    expectForgotten('gone', ['ENOENT', 'ECONNREFUSED', 'EMSGSIZE']));

  it("forgets a send refused by a full backlog or this side's own cap", () =>
    expectForgotten('busy', ['EAGAIN', 'EBUSY']));

  it('reports a reserved bare name as name [ref], in suggestions and on send', async () => {
    const shadowed = peer('s1', 'build');
    peers(shadowed);
    const isReserved = (address: string) => address === 'build';
    const address = `build [${shadowed.ref}]`;
    expect(await sendTo('buil', 'hi', { isReserved })).toEqual(
      NOT_FOUND(address),
    );
    expect(await sendTo(address, 'hi', { isReserved })).toMatchObject(
      SENT(address),
    );
  });

  it('records an address that re-resolves to the same session', async () => {
    // A teammate reserves the bare name and a second peer carries the
    // literal registry name "docs-cd [aaa111]": only "[aaa111]" selects
    // s1 uniquely, and that is what the ledger must remember.
    const s1 = { ...peer('s1', 'docs-cd'), ref: 'aaa111' };
    const s2 = { ...peer('s2', 'docs-cd [aaa111]', '/w/two'), ref: 'bbb222' };
    peers(s1, s2);
    const isReserved = (address: string) => address === 'docs-cd';

    const outcome = await sendTo('[aaa111]', 'hi', { isReserved });
    expect(outcome).toMatchObject({ ...SENT('[aaa111]'), peer: s1 });
    expect(resolvePeerTarget([s1, s2], '[aaa111]')).toEqual({
      kind: 'one',
      peer: s1,
    });
    // The ledger half: `peer-messaging` forwards `settled.address` into the
    // notice the sender reads, so recording anything but the round-trippable
    // address re-advertises the reserved bare name and a re-send lands on the
    // teammate instead of this peer.
    expect(ledgerAt()).toMatchObject({ address: '[aaa111]', state: 'pending' });

    // Same session, spelled with padding the resolver trims: the ledger must
    // record the address that re-resolves, never the caller's raw target.
    await sendTo('  [aaa111]  ', 'hi again', { isReserved });
    expect(ledgerAt(1)).toMatchObject({ address: '[aaa111]' });
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
    peers(...all);
    const isReserved = (address: string) => address === 'docs';
    expect(advertisablePeerAddress(docs, all, isReserved)).toBeUndefined();

    const outcome = await sendTo('aaa111', 'hi', { isReserved });
    expect(outcome).toMatchObject({ ...SENT('aaa111'), peer: docs });
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
    expect(ledgerAt()).toMatchObject({ address: 'aaa111', state: 'pending' });
  });

  it('says so when no address distinguishes an ambiguous pair', async () => {
    // One name over a 6-hex ref collision. Both sessions print the same
    // `name [ref]`, so listing it twice hands the caller one string and the
    // advice to "re-send with the full name [ref]" cannot be followed.
    peers(
      peer('s1', 'app-ab', '/w/one', 'abc123'),
      peer('s2', 'app-ab', '/w/two', 'abc123'),
    );
    const outcome = await sendTo('app-ab');
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
    peers(peer('s1', 'app-ab'));
    sendPeerFrame.mockRejectedValue(new PeerSendError('slow', 'ETIMEDOUT'));
    await sendTo('app-ab');
    expect(ledgerAt()).toMatchObject({ address: 'app-ab', state: 'pending' });
  });

  it('answers only for ids this session sent', () => {
    expect(lookupSentPeerMessageForTest('never-sent')).toBeUndefined();
  });

  it('forgets the oldest send past the cap', async () => {
    peers(peer('s1', 'app-ab'));
    for (let i = 0; i <= MAX_TRACKED_SENDS; i += 1) {
      // Two hundred sends to one target is far past what its mirror
      // bucket allows in a burst; this case is about the ledger's own
      // cap, so the pacer is kept out of the way.
      resetSendPacerForTest();
      await sendTo('app-ab', `m${i}`);
    }
    expect(ledgerAt(0)).toBeUndefined();
    expect(ledgerAt(-1)).toBeDefined();
  });
});

describe('settleSentPeerMessage', () => {
  // A distinct body each time: the mirror refuses a verbatim repeat to
  // one target inside the receiver's dedup window, and these cases are
  // about the ledger rather than about that.
  let sendCounter = 0;
  async function sendOne(): Promise<string> {
    peers(peer('s1', 'app-ab'));
    sendCounter += 1;
    await sendTo('app-ab', `hi ${sendCounter}`);
    return frameAt(-1).msgId as string;
  }

  it('reports the first receipt and the state it moved from', async () => {
    const id = await sendOne();
    expect(settle(id, 'held')).toEqual(receipt('pending'));
    expect(settle(id, 'delivered')).toEqual(receipt('held'));
  });

  it('drops a repeated receipt', async () => {
    const id = await sendOne();
    expect(settle(id, 'held')).toBeDefined();
    expect(settle(id, 'held')).toBeUndefined();
    expect(settle(id, 'denied')).toBeDefined();
    expect(settle(id, 'denied')).toBeUndefined();
    expect(settle(id, 'held')).toBeUndefined();
  });

  it('lets a delivery be corrected to expired exactly once', async () => {
    const id = await sendOne();
    expect(settle(id, 'delivered')).toBeDefined();
    expect(settle(id, 'expired')).toMatchObject({ previous: 'delivered' });
    expect(settle(id, 'expired')).toBeUndefined();
    expect(settle(id, 'delivered')).toBeUndefined();
  });

  it('lets a delivery be corrected to misaddressed exactly once', async () => {
    const id = await sendOne();
    expect(settle(id, 'delivered')).toBeDefined();
    expect(settle(id, 'misaddressed')).toMatchObject({ previous: 'delivered' });
    expect(settle(id, 'misaddressed')).toBeUndefined();
  });

  it('lets a hold be corrected to expired or misaddressed', async () => {
    for (const next of ['expired', 'misaddressed'] as const) {
      const id = await sendOne();
      expect(settle(id, 'held')).toBeDefined();
      expect(settle(id, next)).toMatchObject({ previous: 'held' });
      expect(settle(id, 'delivered')).toBeUndefined();
    }
  });

  it('reports a refusal, and only from pending', async () => {
    const id = await sendOne();
    expect(settle(id, 'refused')).toMatchObject({ previous: 'pending' });

    // A message already parked was not turned away, so a 'refused'
    // receipt after a hold is a peer contradicting itself.
    const held = await sendOne();
    expect(settle(held, 'held')).toBeDefined();
    expect(settle(held, 'refused')).toBeUndefined();

    // Nor after delivery. Any process that can reach this session's socket can
    // write a receipt for any id, so a contradicting peer must not be able to
    // flip a delivered message into "does not accept messages -- don't re-send
    // it" and have the model abandon a send the recipient already has.
    const delivered = await sendOne();
    expect(settle(delivered, 'delivered')).toBeDefined();
    expect(settle(delivered, 'refused')).toBeUndefined();
  });

  it('treats a terminal state as final', async () => {
    const states = 'held delivered denied refused expired misaddressed'.split(
      ' ',
    ) as State[];
    // Every state after held and delivered is terminal.
    for (const terminal of states.slice(2)) {
      const id = await sendOne();
      expect(settle(id, terminal)).toBeDefined();
      for (const next of states) {
        expect(settle(id, next)).toBeUndefined();
      }
    }
  });

  it('answers only for ids this session sent', () => {
    expect(settle('never-sent', 'held')).toBeUndefined();
  });

  it('matches ids the way the receiving gate does', async () => {
    const id = await sendOne();
    expect(settle(id.toUpperCase(), 'held')).toBeDefined();
  });
});

describe('sender-side pacing', () => {
  beforeEach(() => {
    peers(PACED);
  });

  it('refuses the send that would be dropped, and says what to do instead', async () => {
    await burst(CAP, 'message', true);
    expectRefused(
      await send('one too many'),
      `${CAP} were sent`,
      'Batch what remains into one message',
    );
  });

  it('does not write, or remember, a send it refused', async () => {
    // The ledger half matters as much as the write: a refused send left
    // in it would sit `pending` forever, and evict a real send whose
    // receipt still needs its slot.
    await burst(CAP);
    const writes = sendPeerFrame.mock.calls.length;
    const lastRealId = frameAt(-1).msgId as string;

    await send('one too many');
    // No frame, so no id, so nothing for a receipt to answer for.
    expect(sendPeerFrame.mock.calls).toHaveLength(writes);
    // And the ledger is untouched: the last thing in it is still the last
    // send that really happened.
    expect(lookupSentPeerMessageForTest(lastRealId)).toBeDefined();
    const bodies = sendPeerFrame.mock.calls.map((c) => c[1].message.content);
    expect(bodies.filter((body) => body === 'one too many')).toHaveLength(0);
  });

  it('gives the token back when the frame provably never left', async () => {
    // Leave one token so the failing send actually reaches the socket.
    await burst(CAP - 1);
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
    await burst(CAP - 1);
    // A timeout proves nothing: the peer may read the bytes once it is
    // free, so the token stays spent.
    sendPeerFrame.mockRejectedValueOnce(new PeerSendError('slow', 'ETIMEDOUT'));
    expect((await send('maybe arrived')).kind).toBe('failed');

    sendPeerFrame.mockResolvedValue(undefined);
    expect((await send('next one')).kind).toBe('failed');
  });

  it('reports a repeat when the body and token limits both bind', async () => {
    await burst(CAP);
    expectRefused(await send(`message ${CAP - 1}`), 'turns away a repeat');
  });

  it('keeps a separate mirror per target', async () => {
    peers(PACED, peer('p2', 'app-b'));
    await burst(CAP);
    expect((await send('one too many')).kind).toBe('failed');

    // A quiet peer is not paced by a noisy one.
    expect((await sendTo('app-b', 'hello')).kind).toBe('sent');
  });

  it('empties the mirror when the receiver says it was already over', async () => {
    expect((await send('first')).kind).toBe('sent');
    // Other senders share that bucket, so the receiver is the authority.
    drainSendPacer(PACED.ipcPath);
    const refused = await send('second');
    // One real send, not a full bucket: the drain is the receiver's
    // level, so the count the refusal quotes stays this session's own.
    expectRefused(refused, '1 were sent');
    expect(reasonOf(refused)).not.toContain(`${CAP} were sent`);
  });

  it('a refusal late in a burst quotes the count that emptied the bucket', async () => {
    await withClock(async (advance) => {
      expect((await send('first')).kind).toBe('sent');
      drainSendPacer(PACED.ipcPath);
      // Sending at the refill rate keeps the bucket empty: odd seconds
      // refuse, even seconds spend the token that just grew back. Once a
      // refusal lands past the burst window it must still quote the
      // window that emptied the bucket, not a fresh zeroed one.
      let lateRefusal: Outcome | undefined;
      for (
        let seconds = 1;
        seconds <= PEER_BURST_WINDOW_MS / 1000 + 1;
        seconds++
      ) {
        const clock = advance(1000);
        const outcome = await send(`paced ${seconds}`);
        if (clock > PEER_BURST_WINDOW_MS && outcome.kind === 'failed') {
          lateRefusal = outcome;
          break;
        }
      }
      expect(lateRefusal).toBeDefined();
      expect(reasonOf(lateRefusal!)).toContain('31 were sent');
      expect(reasonOf(lateRefusal!)).not.toContain(': 0 were sent');
    });
  });

  it('refills the mirror once the burst window has passed', async () => {
    await withClock(async (advance) => {
      await burst(CAP, 'message', true);
      expect((await send('one too many')).kind).toBe('failed');

      advance(PEER_BURST_WINDOW_MS + 1);
      expect((await send('after the window')).kind).toBe('sent');
    });
  });

  it('refuses a repeat the receiver would drop, without writing it', async () => {
    // The mirror knows the receiver remembers this exact body and will
    // turn it away before policy, so writing it would spend a connection
    // there and tell the caller "sent" for a message nobody reads.
    expect((await send('stuck on this')).kind).toBe('sent');
    const writes = sendPeerFrame.mock.calls.length;

    expectRefused(await send('stuck on this'), 'turns away a repeat');
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
    await burst(CAP - 1, 'different', true);
    expect((await send('one too many')).kind).toBe('failed');
  });

  it('lets the same body through once the receiver has forgotten it', async () => {
    await withClock(async (advance) => {
      expect((await send('say it again')).kind).toBe('sent');
      expect((await send('say it again')).kind).toBe('failed');
      advance(PEER_ADMISSION_LIMITS.dedupWindowMs + 1);
      expect((await send('say it again')).kind).toBe('sent');
    });
  });
});

describe('dropped receipts on the send side', () => {
  it('settles a pending message', () => {
    trackSentPeerMessageForTest('sent-1', 'app-a');
    expect(settle('sent-1', 'dropped')).toEqual(
      receipt('pending', 'app-a', 'app-a'),
    );
  });

  it.each([
    // A drop is decided before the message is anything to the receiver,
    // so one naming a held message is answering a later frame that reused
    // the id — applying it would say a delivered message never arrived.
    ['does not un-hold a message that was already parked', 'sent-2', 'held'],
    [
      'does not un-deliver a message that already landed',
      'sent-3',
      'delivered',
    ],
    ['is terminal', 'sent-4', 'dropped', 'expired'],
  ] as const)('%s', (_title, id, first, next: State = 'dropped') => {
    trackSentPeerMessageForTest(id, 'app-a');
    settle(id, first);
    expect(settle(id, next)).toBeUndefined();
  });

  it('answers for nothing a stranger names', () => {
    expect(settle('never-sent', 'dropped')).toBeUndefined();
  });
});

describe('the mirror and the receiver disagreeing', () => {
  beforeEach(() => {
    peers(PACED);
  });

  it('ages repeat records across a system suspend like the receiver', async () => {
    let wall = 0;
    setSendPacerClockForTest(
      () => 0,
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

  it('keeps one mirror per inbox address when the session id changes', async () => {
    // Several sessions can share one inbox, and the receiver meters by
    // the address a frame arrives on — so a new session id under the
    // same address neither refills the bucket nor forgets the bodies,
    // or alternating between siblings would reset both on every send.
    expect((await send('same body')).kind).toBe('sent');
    peers({ ...PACED, sessionId: 'p2', ref: peerRef('p2') });
    expectRefused(await send('same body'), 'turns away a repeat');
  });

  it('paces two sessions behind one inbox as one destination', async () => {
    const siblingA = { ...peer('sa', 'app-aa'), ipcPath: '/tmp/shared.sock' };
    const siblingB = { ...peer('sb', 'app-bb'), ipcPath: '/tmp/shared.sock' };
    peers(siblingA, siblingB);

    // The duplicate window is shared: a body one sibling just received
    // is a repeat when addressed to the other.
    expect((await sendTo('app-aa', 'same body')).kind).toBe('sent');
    expectRefused(await sendTo('app-bb', 'same body'), 'turns away a repeat');

    // And the rate budget is shared: a burst exhausted against one
    // sibling leaves nothing for the other.
    await burst(CAP - 1, 'burst', true, 'app-aa');
    expectRefused(await sendTo('app-bb', 'one too many'), 'rate limit');
  });

  it('does not un-drain the mirror with a refund that lands after the drain', async () => {
    // The drain is the receiver's own word on its level. A refund from a
    // send that was in flight at the time must not quietly restore the
    // token it just took away.
    await withClock(async () => {
      expect((await send('first')).kind).toBe('sent');
      const stalled = stallNextWrite();
      const inFlight = send('second');
      // The receiver answers an earlier message while this one is still
      // on the wire.
      drainSendPacer(PACED.ipcPath);
      stalled.fail?.();
      expect((await inFlight).kind).toBe('failed');

      sendPeerFrame.mockResolvedValue(undefined);
      expect((await send('third')).kind).toBe('failed');
    });
  });

  it('does not quote a zero-message burst after a drain races a refund', async () => {
    await withClock(async () => {
      const stalled = stallNextWrite();
      const inFlight = send('never arrived');
      await vi.waitFor(() => expect(stalled.fail).toBeTypeOf('function'));
      drainSendPacer(PACED.ipcPath);
      stalled.fail?.();
      await inFlight;

      sendPeerFrame.mockResolvedValue(undefined);
      const refused = await send('next body');
      expect(refused.kind).toBe('failed');
      expect(reasonOf(refused)).not.toContain(': 0 were sent');
    });
  });

  it('keeps uncertain reset writes in the ledger and repeat baseline', async () => {
    sendPeerFrame.mockRejectedValueOnce(
      new PeerSendError('reset after connect', 'ECONNRESET'),
    );
    expect((await send('maybe arrived')).kind).toBe('failed');
    expect(ledgerAt()).toBeDefined();

    sendPeerFrame.mockResolvedValue(undefined);
    expectRefused(await send('maybe arrived'), 'turns away a repeat');
    expect(sendPeerFrame).toHaveBeenCalledTimes(1);
  });

  it('restores the body the receiver still remembers when a send is refunded', async () => {
    // Clearing the record instead would make the next send of the earlier
    // body cost a token here while the receiver drops it for free — the
    // mirror drifting below the real bucket, which it must never do.
    await withClock(async () => {
      expect((await send('A')).kind).toBe('sent');
      sendPeerFrame.mockRejectedValueOnce(new PeerSendError('busy', 'EAGAIN'));
      expect((await send('C')).kind).toBe('failed');
      sendPeerFrame.mockResolvedValue(undefined);

      // The receiver never saw C, and still remembers A.
      expectRefused(await send('A'), 'turns away a repeat');
    });
  });

  it('forgets a body the receiver reports as undelivered', async () => {
    await withClock(async () => {
      expect((await send('A')).kind).toBe('sent');
      expect((await send('B')).kind).toBe('sent');
      forgetSendPacerMessages(PACED.ipcPath, [frameAt(1).msgId as string]);

      expectRefused(await send('A'), 'turns away a repeat');
      expect((await send('B')).kind).toBe('sent');
    });
  });

  it('refunds the token for a message rejected before admission', async () => {
    await withClock(async () => {
      await burst(CAP, 'body', true);
      const firstId = frameAt().msgId as string;
      expect((await send('over capacity')).kind).toBe('failed');

      refundSendPacerMessage(PACED.ipcPath, firstId);

      expect((await send('after misaddressed')).kind).toBe('sent');
    });
  });

  it('refunds a duplicate token without forgetting its body', async () => {
    await withClock(async () => {
      await burst(CAP, 'body', true);
      refundSendPacerToken(PACED.ipcPath, frameAt(-1).msgId as string);

      expectRefused(await send(`body ${CAP - 1}`), 'turns away a repeat');
      expect((await send('different body')).kind).toBe('sent');
    });
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
    await withClock(async (advance) => {
      const perWindow =
        (PEER_BURST_WINDOW_MS / 1000) * PEER_ADMISSION_LIMITS.refillPerSecond;
      for (let step = 0; step < PEER_BURST_WINDOW_MS / 1000 + 60; step += 2) {
        advance(2000);
        await send(`paced ${step}`);
        drainSendPacer(PACED.ipcPath);
      }
      advance(1);
      const refusal = await send('one more');
      expect(refusal.kind).toBe('failed');
      const quoted = Number(
        /: (\d+) were sent/.exec(reasonOf(refusal) || '')?.[1] ?? '-1',
      );
      expect(quoted).toBeGreaterThanOrEqual(0);
      expect(quoted).toBeLessThanOrEqual(perWindow + 1);
    });
  });
});
