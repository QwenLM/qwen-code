/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end over a real socket: a frame written by the client comes out
 * of the gate and lands in the submit function, wrapped and attributed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ApprovalMode,
  buildDeliveryStatusFrame,
  buildUserFrame,
  MAX_HELD_MESSAGES,
  MAX_SETTLED_IDS,
  resetSentPeerMessagesForTest,
  sendPeerFrame,
  startPeerInbox,
  trackSentPeerMessageForTest,
  type InboundPolicy,
  type PolicyScope,
  type PeerFrame,
  type PeerInbox,
} from '@qwen-code/qwen-code-core';
import {
  MAX_ACCEPTED_BACKLOG,
  MESSAGING_SOCKET_ENV,
  MESSAGING_TOKEN_ENV,
  PeerMessaging,
  type PeerQueuedDelivery,
} from './peer-messaging.js';

// Holds the inbox's post-listen socket chmod, keeping startPeerInbox
// pending while the socket already accepts connections.
const chmodControl = vi.hoisted(() => ({
  holdSocketChmod: false,
  calls: 0,
  release: null as (() => void) | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      chmodControl.calls += 1;
      if (chmodControl.holdSocketChmod && chmodControl.calls === 2) {
        await new Promise<void>((r) => (chmodControl.release = r));
      }
      return actual.chmod(...args);
    },
  };
});

const isWindows = process.platform === 'win32';

/**
 * Injected through the `ipcToken` seam so every staged sender — including
 * one racing the bind window, where the generated token would not be
 * observable yet — can authenticate to the inbox under test.
 */
const TEST_TOKEN = 'test-inbox-token';
/** The token children get; see `childToken` on PeerMessagingOptions. */
const TEST_CHILD_TOKEN = 'test-child-token';

function send(
  socketPath: string,
  frame: PeerFrame,
  options: { authToken?: string } = { authToken: TEST_TOKEN },
): Promise<void> {
  return sendPeerFrame(socketPath, frame, options);
}

/**
 * A frame from a peer in the same review class as the receiver under test
 * (every test starts it prompting unless it says otherwise). The gate holds
 * a frame that asserts no class, so the tests about everything *after* the
 * gate assert one; the tests about the gate itself build their own.
 */
function peerFrame(
  fields: Parameters<typeof buildUserFrame>[0],
): ReturnType<typeof buildUserFrame> {
  return buildUserFrame({ fromMode: 'prompting', ...fields });
}

let tmpDir: string;
let messaging: PeerMessaging | null = null;
/** Stands in for the peer that sent us something, to collect receipts. */
let senderInbox: PeerInbox | null = null;
let receipts: PeerFrame[];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-peer-msg-'));
  receipts = [];
  chmodControl.holdSocketChmod = false;
  chmodControl.calls = 0;
  chmodControl.release = null;
  // The ledger is a module singleton shared by every test in this file.
  resetSentPeerMessagesForTest();
});

afterEach(async () => {
  await messaging?.close();
  messaging = null;
  await senderInbox?.close();
  senderInbox = null;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function startSenderInbox(): Promise<PeerInbox> {
  const inbox = await startPeerInbox({
    socketPath: path.join(tmpDir, 'socks', 'sender.sock'),
    onFrame: (frame) => receipts.push(frame),
  });
  if (!inbox) throw new Error('sender inbox failed to start');
  senderInbox = inbox;
  return inbox;
}

async function start(
  mode: ApprovalMode | null = ApprovalMode.DEFAULT,
  extra: {
    getSessionId?: () => string;
    settleSentMessage?: (
      msgId: string,
      status: string,
    ) => { address: string; previous: 'pending' | 'held' } | undefined;
    reassertSessionRecord?: () => Promise<void>;
    getPolicySetting?: () => InboundPolicy | undefined;
    getHeldExpiryMs?: () => number | null;
    getPolicyScope?: () => PolicyScope | undefined;
  } = {},
): Promise<{
  messaging: PeerMessaging;
  submitted: Array<{ modelText: string; displayText: string }>;
}> {
  const submitted: Array<{ modelText: string; displayText: string }> = [];
  const started = await PeerMessaging.start({
    socketPath: path.join(tmpDir, 'socks', 'self.sock'),
    getApprovalMode: () => mode,
    getPolicySetting: () => undefined,
    updateSessionRegistryIpcPath: async () => {},
    ipcToken: TEST_TOKEN,
    childToken: TEST_CHILD_TOKEN,
    ...extra,
  });
  if (!started) throw new Error('peer messaging failed to start');
  messaging = started;
  started.setSubmitFn((modelText, displayText) => {
    submitted.push({ modelText, displayText });
    return true;
  });
  return { messaging: started, submitted };
}

describe.skipIf(isWindows)('PeerMessaging', () => {
  it('delivers an accepted message wrapped in an envelope', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT);
    await send(
      m.socketPath!,
      peerFrame({
        content: 'check the tests over there',
        from: '/tmp/peer.sock',
        fromName: 'app-ab',
      }),
    );
    await settle();

    expect(submitted).toHaveLength(1);
    expect(submitted[0].modelText).toContain(
      '<cross_session_message from="/tmp/peer.sock" name="app-ab">',
    );
    expect(submitted[0].modelText).toContain('check the tests over there');
    expect(submitted[0].modelText).toContain('permission laundering');
    expect(submitted[0].displayText).toContain('app-ab');
  });

  it('surfaces a receipt for a message this session sent', async () => {
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      settleSentMessage: (msgId) =>
        msgId === 'sent-0001'
          ? {
              address: 'docs-cd [ab12cd]',
              previous: 'pending',
            }
          : undefined,
    });
    const seen: Array<{ status: string; address: string; origMsgId: string }> =
      [];
    m.onReceipt((receipt) => seen.push(receipt));

    await send(
      m.socketPath!,
      buildDeliveryStatusFrame({
        status: 'held',
        origMsgId: 'sent-0001',
        from: '/tmp/peer.sock',
      }),
    );
    await settle();

    expect(seen).toEqual([
      {
        status: 'held',
        address: 'docs-cd [ab12cd]',
        origMsgId: 'sent-0001',
        previous: 'pending',
      },
    ]);
  });

  it('drops a receipt the ledger does not settle (unknown id, or a repeat)', async () => {
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      settleSentMessage: () => undefined,
    });
    const seen: unknown[] = [];
    m.onReceipt((receipt) => seen.push(receipt));

    await send(
      m.socketPath!,
      buildDeliveryStatusFrame({
        status: 'denied',
        origMsgId: 'forged-0001',
        from: '/tmp/peer.sock',
      }),
    );
    await settle();

    expect(seen).toEqual([]);
  });

  it('settles receipts through the real ledger when none is injected', async () => {
    // Production passes no settleSentMessage, so the default
    // settleSentPeerMessage runs — a path every other receipt test stubs
    // out. The ledger's own outcomes are covered in peer-send.test.ts;
    // what needs pinning here is that the default is wired at all, so an
    // id this session never sent settles to nothing and the frame is
    // dropped rather than announced or thrown on.
    const { messaging: m } = await start(ApprovalMode.DEFAULT);
    const seen: unknown[] = [];
    m.onReceipt((receipt) => seen.push(receipt));

    await send(
      m.socketPath!,
      buildDeliveryStatusFrame({
        status: 'denied',
        origMsgId: 'never-sent-by-this-session',
        from: '/tmp/peer.sock',
      }),
    );
    await settle();

    expect(seen).toEqual([]);
  });

  it('surfaces a real-ledger receipt with the address the send recorded', async () => {
    // The case above only proves the default drops what it should. A
    // default swapped for a no-op returning undefined passes it just as
    // happily — and in production that silently loses every receipt, since
    // `startInteractiveUI` injects no `settleSentMessage`. This drives the
    // other direction through the same unstubbed default: an id the real
    // ledger holds must come back out of `onReceipt` carrying the ledger's
    // own `address` and `previous`, neither of which the frame supplies.
    trackSentPeerMessageForTest('sent-real-0001', 'docs-cd [ab12cd]');
    const { messaging: m } = await start(ApprovalMode.DEFAULT);
    const seen: unknown[] = [];
    m.onReceipt((receipt) => seen.push(receipt));

    await send(
      m.socketPath!,
      buildDeliveryStatusFrame({
        status: 'held',
        origMsgId: 'sent-real-0001',
        from: '/tmp/peer.sock',
      }),
    );
    await settle();

    expect(seen).toEqual([
      {
        status: 'held',
        address: 'docs-cd [ab12cd]',
        origMsgId: 'sent-real-0001',
        previous: 'pending',
      },
    ]);
  });

  it('keeps delivering receipts when one listener throws', async () => {
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      settleSentMessage: () => ({
        address: 'docs-cd',
        previous: 'pending',
      }),
    });
    const seen: unknown[] = [];
    m.onReceipt(() => {
      throw new Error('listener bug');
    });
    m.onReceipt((receipt) => seen.push(receipt));

    await send(
      m.socketPath!,
      buildDeliveryStatusFrame({ status: 'expired', origMsgId: 'sent-0002' }),
    );
    await settle();

    expect(seen).toHaveLength(1);
  });

  it('refuses a message pinned to another session id, with a receipt', async () => {
    const sender = await startSenderInbox();
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT, {
      getSessionId: () => 'session-now',
    });
    const frame = peerFrame({
      content: 'meant for whoever had this pid before',
      from: sender.socketPath,
      toSessionId: 'session-before',
    });
    await send(m.socketPath!, frame);
    await settle();

    expect(submitted).toHaveLength(0);
    expect(m.getHeld()).toHaveLength(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      type: 'control',
      status: 'misaddressed',
      origMsgId: frame.msgId,
      from: m.socketPath,
    });
  });

  it('admits a pinned message when it has no session id to judge it against', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT);
    await send(
      m.socketPath!,
      peerFrame({
        content: 'hello',
        from: '/tmp/peer.sock',
        toSessionId: 'some-session',
      }),
    );
    await settle();
    expect(submitted).toHaveLength(1);
  });

  it('re-asserts its registry record when a pinned frame misses', async () => {
    const reassert = vi.fn().mockResolvedValue(undefined);
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      getSessionId: () => 'session-now',
      reassertSessionRecord: reassert,
    });
    await send(
      m.socketPath!,
      peerFrame({
        content: 'stale',
        from: '/tmp/peer.sock',
        toSessionId: 'session-before',
      }),
    );
    await settle();
    expect(reassert).toHaveBeenCalledTimes(1);
  });

  it('judges a frame that arrives before bind completes against the pin too', async () => {
    // startPeerInbox resolves only after its post-listen chmod; frames
    // dispatched in that window must already see the session id.
    // The sender inbox first, so its own chmods do not race for the
    // held slot; the hold engages on the inbox's post-listen chmod.
    const sender = await startSenderInbox();
    chmodControl.calls = 0;
    chmodControl.holdSocketChmod = true;
    const submitted: string[] = [];
    const starting = PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
      getSessionId: () => 'session-now',
    });
    // Wait until the listener exists and its chmod is being held.
    for (let i = 0; i < 100 && chmodControl.release === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (chmodControl.release === null) throw new Error('chmod hold missed');
    const frame = peerFrame({
      content: 'early and misaddressed',
      from: sender.socketPath,
      toSessionId: 'session-before',
    });
    await send(path.join(tmpDir, 'socks', 'self.sock'), frame);
    await settle();
    chmodControl.release?.();
    const started = await starting;
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    await settle();

    expect(submitted).toHaveLength(0);
    expect(started.getHeld()).toHaveLength(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      type: 'control',
      status: 'misaddressed',
      origMsgId: frame.msgId,
    });
  });

  it('admits a message pinned to its own session id', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT, {
      getSessionId: () => 'session-now',
    });
    await send(
      m.socketPath!,
      peerFrame({
        content: 'hello',
        from: '/tmp/peer.sock',
        toSessionId: 'session-now',
      }),
    );
    await settle();
    expect(submitted).toHaveLength(1);
  });

  it('admits an unpinned message from an older sender', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT, {
      getSessionId: () => 'session-now',
    });
    await send(
      m.socketPath!,
      peerFrame({ content: 'hello', from: '/tmp/peer.sock' }),
    );
    await settle();
    expect(submitted).toHaveLength(1);
  });

  it('judges the pin against the id this session holds now, not at start', async () => {
    let current = 'session-a';
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT, {
      getSessionId: () => current,
    });
    current = 'session-b';
    await send(
      m.socketPath!,
      peerFrame({
        content: 'after /clear',
        from: '/tmp/peer.sock',
        toSessionId: 'session-b',
      }),
    );
    await settle();
    expect(submitted).toHaveLength(1);
  });

  it('drops a held frame when the session id swaps before reevaluation', async () => {
    const sender = await startSenderInbox();
    let mode = ApprovalMode.YOLO;
    let current = 'session-a';
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => mode,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
      getSessionId: () => current,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    const frame = peerFrame({
      content: 'held before /clear',
      from: sender.socketPath,
      fromMode: 'prompting',
      toSessionId: 'session-a',
    });
    await send(started.socketPath!, frame);
    await settle();
    expect(started.getHeld()).toHaveLength(1);

    current = 'session-b';
    mode = ApprovalMode.DEFAULT;
    expect(started.reevaluate('approval-mode-changed')).toBe(0);
    expect(started.getHeld()).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    await settle();
    const statuses = receipts
      .filter((receipt) => receipt.type === 'control')
      .filter((receipt) => receipt.origMsgId === frame.msgId)
      .map((receipt) => receipt.status);
    expect(statuses).toEqual(['held', 'misaddressed']);
  });

  it('drops a queued envelope whose pin the session outgrew at drain', async () => {
    const sender = await startSenderInbox();
    let current = 'session-a';
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
      getSessionId: () => current,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    const queued: PeerQueuedDelivery[] = [];
    started.setSubmitFn((_modelText, _displayText, delivery) => {
      if (delivery) queued.push(delivery);
      return true;
    });
    const frame = peerFrame({
      content: 'queued before /clear',
      from: sender.socketPath,
      toSessionId: 'session-a',
    });
    await send(started.socketPath!, frame);
    await settle();
    expect(queued).toEqual([
      {
        msgId: frame.msgId,
        from: sender.socketPath,
        toSessionId: 'session-a',
      },
    ]);

    current = 'session-b';
    expect(started.drainQueuedFrame(queued[0])).toBe(false);
    await settle();
    const statuses = receipts
      .filter((receipt) => receipt.type === 'control')
      .map((receipt) => receipt.status);
    expect(statuses).toEqual(['delivered', 'misaddressed']);
  });

  it('drains a matching or unpinned queued envelope', async () => {
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      getSessionId: () => 'session-a',
    });
    expect(m.drainQueuedFrame({ msgId: 'm1', toSessionId: 'session-a' })).toBe(
      true,
    );
    expect(m.drainQueuedFrame({ msgId: 'm2' })).toBe(true);
    expect(m.drainQueuedFrame(undefined)).toBe(true);
  });

  it('holds a message when the receiver bypasses prompts and the sender says nothing', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.YOLO);
    await send(
      m.socketPath!,
      buildUserFrame({ content: 'run the deploy', from: '/tmp/peer.sock' }),
    );
    await settle();

    expect(submitted).toHaveLength(0);
    expect(m.getHeld()).toHaveLength(1);
    expect(m.getHeld()[0].cause).toBe('no-mode-asserted');
  });

  it('carries the configured policy scope through the session gate', async () => {
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      getPolicySetting: () => 'hold',
      getPolicyScope: () => 'workspace',
    });
    await send(
      m.socketPath!,
      peerFrame({ content: 'review me', from: '/tmp/peer.sock' }),
    );
    await settle();

    expect(m.getHeld()).toMatchObject([
      { cause: 'explicit-setting', policyScope: 'workspace' },
    ]);
  });

  it('holds a bypassing sender when the receiver prompts, until the receiver bypasses too', async () => {
    let mode = ApprovalMode.DEFAULT;
    const submitted: string[] = [];
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => mode,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });

    await send(
      started.socketPath!,
      buildUserFrame({
        content: 'apply the migration',
        from: '/tmp/peer.sock',
        fromMode: 'bypass',
      }),
    );
    await settle();
    expect(submitted).toHaveLength(0);
    expect(started.getHeld()).toMatchObject([{ cause: 'mode-mismatch' }]);

    mode = ApprovalMode.YOLO;
    expect(started.reevaluate('mode-changed')).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(started.getHeld()).toHaveLength(0);
  });

  it('releases a held message when approved', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.YOLO);
    await send(
      m.socketPath!,
      peerFrame({ content: 'run the deploy', from: '/tmp/peer.sock' }),
    );
    await settle();

    const msgId = m.getHeld()[0].frame.msgId;
    expect(m.decide(msgId, 'approve')).toBe('done');
    expect(submitted).toHaveLength(1);
    expect(m.getHeld()).toHaveLength(0);
  });

  it('admits a frame that lands while startup is still settling', async () => {
    chmodControl.holdSocketChmod = true;
    const socketPath = path.join(tmpDir, 'socks', 'self.sock');
    const startPromise = PeerMessaging.start({
      socketPath,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });

    await vi.waitFor(() => {
      expect(fsSync.existsSync(socketPath)).toBe(true);
    });
    await send(
      socketPath,
      peerFrame({ content: 'early frame', from: '/tmp/peer.sock' }),
    );
    await settle();

    chmodControl.release?.();
    const started = await startPromise;
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('early frame');
  });

  it('buffers a message that arrives before the queue is wired', async () => {
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    await send(
      started.socketPath!,
      peerFrame({ content: 'early bird', from: '/tmp/peer.sock' }),
    );
    await settle();

    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('early bird');
    expect(submitted[0]).not.toContain('origin="own-process"');
  });

  it('sends a delivery receipt back to the sender', async () => {
    const sender = await startSenderInbox();
    const { messaging: m } = await start(ApprovalMode.DEFAULT);

    const frame = peerFrame({
      content: 'hi',
      from: sender.socketPath,
    });
    await send(m.socketPath!, frame);
    await settle();

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      type: 'control',
      status: 'delivered',
      origMsgId: frame.msgId,
    });
  });

  it('reports held, then delivered, as the decision is made', async () => {
    const sender = await startSenderInbox();
    const { messaging: m } = await start(ApprovalMode.YOLO);

    const frame = peerFrame({ content: 'hi', from: sender.socketPath });
    await send(m.socketPath!, frame);
    await settle();
    expect(receipts.map((r) => (r as { status: string }).status)).toEqual([
      'held',
    ]);

    m.decide(frame.msgId, 'approve');
    await settle();
    expect(receipts.map((r) => (r as { status: string }).status)).toEqual([
      'held',
      'delivered',
    ]);
  });

  it('expires held messages on close so the sender is not left waiting', async () => {
    const sender = await startSenderInbox();
    const { messaging: m } = await start(ApprovalMode.YOLO);

    const frame = peerFrame({ content: 'hi', from: sender.socketPath });
    await send(m.socketPath!, frame);
    await settle();

    await m.close();
    messaging = null;
    await settle();

    expect(receipts.at(-1)).toMatchObject({
      status: 'expired',
      origMsgId: frame.msgId,
    });
  });

  it('does not try to answer a sender that gave no reply address', async () => {
    const { messaging: m } = await start(ApprovalMode.DEFAULT);
    await expect(
      send(m.socketPath!, peerFrame({ content: 'anonymous' })),
    ).resolves.toBeUndefined();
    await settle();
    expect(receipts).toHaveLength(0);
  });

  it('ignores an inbound control frame instead of treating it as a message', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT);
    await send(m.socketPath!, {
      msgV: 1,
      msgId: 'c1',
      type: 'control',
      action: 'delivery_status',
      status: 'delivered',
      origMsgId: 'whatever',
    });
    await settle();
    expect(submitted).toHaveLength(0);
  });

  it('releases held messages when the approval mode changes', async () => {
    let mode = ApprovalMode.YOLO;
    const submitted: string[] = [];
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => mode,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });

    await send(
      started.socketPath!,
      peerFrame({ content: 'later', from: '/tmp/peer.sock' }),
    );
    await settle();
    expect(submitted).toHaveLength(0);

    mode = ApprovalMode.DEFAULT;
    expect(started.reevaluate('approval-mode-changed')).toBe(1);
    expect(submitted).toHaveLength(1);
  });

  it('replays already-held messages to a late subscriber', async () => {
    // start() binds the socket before it returns, so a hold can park
    // before the UI subscribes; the subscriber must still hear about it.
    const { messaging: m } = await start(ApprovalMode.YOLO);
    await send(
      m.socketPath!,
      peerFrame({ content: 'early hold', from: '/tmp/peer.sock' }),
    );
    await settle();
    expect(m.getHeld()).toHaveLength(1);

    const seen: number[] = [];
    m.onHeldChange((held) => seen.push(held.length));
    expect(seen).toEqual([1]);
  });

  it('caps the accepted backlog and receipts the overflow as expired', async () => {
    // Accepted frames drain at one per model turn but arrive at socket
    // speed; once the backlog is full the gate must refuse with an honest
    // receipt instead of growing the queue without bound.
    const sender = await startSenderInbox();
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    let accepted = 0;
    started.setSubmitFn(() => {
      // Model a queue that already holds MAX_ACCEPTED_BACKLOG pending
      // submissions, the way AppContainer's wiring reports it.
      if (accepted >= MAX_ACCEPTED_BACKLOG) return false;
      accepted += 1;
      return true;
    });

    const overflow = 5;
    for (let i = 0; i < MAX_ACCEPTED_BACKLOG + overflow; i++) {
      await send(
        started.socketPath!,
        peerFrame({ content: `flood ${i}`, from: sender.socketPath }),
      );
    }
    for (
      let waits = 0;
      waits < 50 && receipts.length < MAX_ACCEPTED_BACKLOG + overflow;
      waits++
    ) {
      await settle();
    }

    expect(accepted).toBe(MAX_ACCEPTED_BACKLOG);
    expect(
      receipts.filter((r) => r.type === 'control' && r.status === 'expired'),
    ).toHaveLength(overflow);
  });

  it('bounds the pre-wiring buffer and flushes it in order once wired', async () => {
    const sender = await startSenderInbox();
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const overflow = 5;
    for (let i = 0; i < MAX_ACCEPTED_BACKLOG + overflow; i++) {
      await send(
        started.socketPath!,
        peerFrame({ content: `early ${i}`, from: sender.socketPath }),
      );
    }
    for (
      let waits = 0;
      waits < 50 && receipts.length < MAX_ACCEPTED_BACKLOG + overflow;
      waits++
    ) {
      await settle();
    }

    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });

    expect(submitted).toHaveLength(MAX_ACCEPTED_BACKLOG);
    expect(submitted[0]).toContain('early 0');
    expect(submitted[MAX_ACCEPTED_BACKLOG - 1]).toContain(
      `early ${MAX_ACCEPTED_BACKLOG - 1}`,
    );
    expect(
      receipts.filter((r) => r.type === 'control' && r.status === 'expired'),
    ).toHaveLength(overflow);
  });

  it('delivers every shutdown expiry receipt past the send cap', async () => {
    // close() must await the expiry receipts and the cap must not drop the
    // flush's tail: a session can hold MAX_HELD_MESSAGES messages, and
    // each one's sender is owed the expiry receipt before the process
    // exits.
    const sender = await startSenderInbox();
    const { messaging: m } = await start(ApprovalMode.YOLO);

    const heldCount = 40;
    for (let i = 0; i < heldCount; i++) {
      await send(
        m.socketPath!,
        peerFrame({ content: `hold ${i}`, from: sender.socketPath }),
      );
    }
    await vi.waitFor(() => expect(m.getHeld()).toHaveLength(heldCount));

    await m.close();
    messaging = null;

    expect(
      receipts.filter((r) => r.type === 'control' && r.status === 'expired'),
    ).toHaveLength(heldCount);
  });

  it('corrects the delivered receipt of a buffered message dropped at exit', async () => {
    const sender = await startSenderInbox();
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    // No submit function wired: the frame is accepted into the buffer.

    const frame = peerFrame({
      content: 'early bird',
      from: sender.socketPath,
    });
    await send(started.socketPath!, frame);
    await settle();
    expect(receipts.map((r) => (r as { status: string }).status)).toEqual([
      'delivered',
    ]);

    await started.close();
    messaging = null;

    expect(receipts.map((r) => (r as { status: string }).status)).toEqual([
      'delivered',
      'expired',
    ]);

    // Wiring after close must not resurrect a corrected message.
    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    expect(submitted).toHaveLength(0);
  });

  it('corrects delivered receipts for messages still queued at exit', async () => {
    const sender = await startSenderInbox();
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const queued: string[] = [];
    started.setSubmitFn((modelText) => {
      queued.push(modelText);
      return true;
    });
    started.setQueuedPeerCount(() => queued.length);

    const consumed = peerFrame({
      content: 'consumed',
      from: sender.socketPath,
    });
    const waiting = peerFrame({
      content: 'waiting',
      from: sender.socketPath,
    });
    await send(started.socketPath!, consumed);
    await send(started.socketPath!, waiting);
    await settle();
    expect(queued).toHaveLength(2);

    // The session consumed the first message; the second dies in the queue.
    queued.shift();

    await started.close();
    messaging = null;

    const statusesFor = (msgId: string) =>
      receipts
        .filter((r) => r.type === 'control' && r.origMsgId === msgId)
        .map((r) => (r as { status: string }).status);
    expect(statusesFor(consumed.msgId)).toEqual(['delivered']);
    expect(statusesFor(waiting.msgId)).toEqual(['delivered', 'expired']);
  });

  it('settles a partially flushed buffer alongside queued frames at exit', async () => {
    // deliver() flushes the buffer before admitting anything new, so the
    // unflushed tail of the buffer always sits after every queued frame in
    // the outstanding set; close must correct both groups, not just one.
    const sender = await startSenderInbox();
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const frames = [0, 1, 2].map((i) =>
      peerFrame({ content: `mixed ${i}`, from: sender.socketPath }),
    );
    for (const frame of frames) {
      await send(started.socketPath!, frame);
    }
    await settle();

    // The queue takes only the first flush; the rest stay buffered.
    const queue: string[] = [];
    started.setSubmitFn((modelText) => {
      if (queue.length >= 1) return false;
      queue.push(modelText);
      return true;
    });
    started.setQueuedPeerCount(() => queue.length);

    await started.close();
    messaging = null;

    const statusesFor = (msgId: string) =>
      receipts
        .filter((r) => r.type === 'control' && r.origMsgId === msgId)
        .map((r) => (r as { status: string }).status);
    for (const frame of frames) {
      expect(statusesFor(frame.msgId)).toEqual(['delivered', 'expired']);
    }
  });

  it('flags a re-admitted body under a reviewed id once its tombstone prunes', async () => {
    // The listing guard must bind to the entries, not just their ids: an
    // evicted id's tombstone is pruned after MAX_SETTLED_IDS further
    // settlements, making the id re-admittable — the same ids in the same
    // order can then mask a swapped body at decide time.
    const sender = await startSenderInbox();
    let mode = ApprovalMode.YOLO;
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => mode,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    started.setSubmitFn(() => true);

    const target = peerFrame({
      content: 'BODY-1',
      from: sender.socketPath,
    });
    await send(started.socketPath!, target);
    await settle();
    started.recordHeldListing(started.getHeld());

    // Evict the target with newer holds, then release them again.
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) {
      await send(
        started.socketPath!,
        peerFrame({ content: `evict ${i}`, from: sender.socketPath }),
      );
    }
    mode = ApprovalMode.DEFAULT;
    started.reevaluate('test');
    expect(started.getHeld()).toHaveLength(0);

    // Prune the target's tombstone with MAX_SETTLED_IDS fresh settlements.
    for (let i = 0; i < MAX_SETTLED_IDS; i++) {
      await send(
        started.socketPath!,
        peerFrame({ content: `churn ${i}`, from: sender.socketPath }),
      );
    }

    // The id is re-admittable now; ids and order match the old listing.
    mode = ApprovalMode.YOLO;
    await send(started.socketPath!, {
      ...target,
      message: { role: 'user', content: 'BODY-2' },
    });
    await vi.waitFor(() => expect(started.getHeld()).toHaveLength(1));

    expect(started.heldSetChangedSinceListing()).toBe(true);
  });

  it('is safe to close twice', async () => {
    const { messaging: m } = await start();
    await m.close();
    await expect(m.close()).resolves.toBeUndefined();
    messaging = null;
  });
});

describe.skipIf(isWindows)('inbox auth wiring', () => {
  it('drops an unauthenticated frame before the gate sees it', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT);
    await send(
      m.socketPath!,
      peerFrame({ content: 'no token', from: '/tmp/peer.sock' }),
      {},
    ).catch(() => {
      // The inbox may reset the connection mid-write.
    });
    await settle();
    expect(submitted).toHaveLength(0);
    expect(m.getHeld()).toHaveLength(0);
  });

  it('publishes the token alongside the socket path, and clears both', async () => {
    const published: Array<[string | undefined, string | undefined]> = [];
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async (ipcPath, ipcToken) => {
        published.push([ipcPath, ipcToken]);
      },
      ipcToken: TEST_TOKEN,
      childToken: TEST_CHILD_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    expect(published).toEqual([[started.socketPath, TEST_TOKEN]]);
    expect(process.env[MESSAGING_SOCKET_ENV]).toBe(started.socketPath);
    // Children are handed the child token, never the published one.
    expect(process.env[MESSAGING_TOKEN_ENV]).toBe(TEST_CHILD_TOKEN);

    await started.close();
    messaging = null;
    expect(published[1]).toEqual([undefined, undefined]);
    expect(process.env[MESSAGING_SOCKET_ENV]).toBeUndefined();
    expect(process.env[MESSAGING_TOKEN_ENV]).toBeUndefined();
  });

  it('drops an inherited address and token when the inbox never binds', async () => {
    // A session that binds no inbox of its own must not hand an ancestor's
    // capability to its children: a hook following the documented injection
    // pattern would authenticate to the ANCESTOR's inbox and land its
    // message in the wrong session's context, reporting success.
    process.env[MESSAGING_SOCKET_ENV] = '/inherited/ancestor.sock';
    process.env[MESSAGING_TOKEN_ENV] = 'inherited-ancestor-token';

    // A regular file where the socket's parent directory should be: the
    // inbox cannot create the directory, so it never binds.
    const blocker = path.join(tmpDir, 'not-a-dir');
    await fs.writeFile(blocker, '');

    const started = await PeerMessaging.start({
      socketPath: path.join(blocker, 'self.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
    });

    expect(started).toBeNull();
    expect(process.env[MESSAGING_SOCKET_ENV]).toBeUndefined();
    expect(process.env[MESSAGING_TOKEN_ENV]).toBeUndefined();
  });

  it('authenticates receipts with the reply token the frame offered', async () => {
    // The sender's inbox requires its own token; a receipt can only land
    // if it carries the replyToken from the original frame.
    const SENDER_TOKEN = 'sender-inbox-token';
    const sender = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'sender.sock'),
      requiredToken: SENDER_TOKEN,
      onFrame: (frame) => receipts.push(frame),
    });
    if (!sender) throw new Error('sender inbox failed to start');
    senderInbox = sender;

    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      getSessionId: () => 'session-now',
    });
    const withToken = peerFrame({
      content: 'stale pin',
      from: sender.socketPath,
      replyToken: SENDER_TOKEN,
      toSessionId: 'session-before',
    });
    await send(m.socketPath!, withToken);
    await settle();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      type: 'control',
      status: 'misaddressed',
      origMsgId: withToken.msgId,
    });

    // Without a replyToken the receipt bounces off the sender's own auth.
    const withoutToken = peerFrame({
      content: 'stale pin, old sender',
      from: sender.socketPath,
      toSessionId: 'session-before',
    });
    await send(m.socketPath!, withoutToken);
    await settle();
    expect(receipts).toHaveLength(1);
  });

  it('authenticates a held receipt, not only the misaddressed one', async () => {
    // The gate's own reportStatus path — held/denied/delivered — is the one
    // a real peer meets first. Without the replyToken the hold signal never
    // reaches the sender's token-required inbox and its ledger sits on
    // 'pending' forever, with nothing to show the user.
    const SENDER_TOKEN = 'held-sender-token';
    const sender = await startPeerInbox({
      socketPath: path.join(tmpDir, 'socks', 'sender.sock'),
      requiredToken: SENDER_TOKEN,
      onFrame: (frame) => receipts.push(frame),
    });
    if (!sender) throw new Error('sender inbox failed to start');
    senderInbox = sender;

    // Policy 'hold' parks the message and reports it back.
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      getPolicySetting: () => 'hold',
    });
    const frame = peerFrame({
      content: 'please review',
      from: sender.socketPath,
      replyToken: SENDER_TOKEN,
    });
    await send(m.socketPath!, frame);
    await settle();

    expect(m.getHeld()).toHaveLength(1);
    expect(receipts).toMatchObject([
      { type: 'control', status: 'held', origMsgId: frame.msgId },
    ]);
  });

  it('generates a 64-hex inbox token when none is injected', async () => {
    // Every other test injects the token through the seam, so the default
    // is the one branch that ships to users: a constant or truncated value
    // here would hand every session the same guessable capability.
    const published: Array<[string | undefined, string | undefined]> = [];
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'generated.sock'),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async (ipcPath, ipcToken) => {
        published.push([ipcPath, ipcToken]);
      },
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const token = published[0][1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const childToken = process.env[MESSAGING_TOKEN_ENV];
    expect(childToken).toMatch(/^[0-9a-f]{64}$/);
    // Two independent draws: a child must not be able to pass as a peer.
    expect(childToken).not.toBe(token);

    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });

    // Both generated capabilities are the ones the inbox actually accepts.
    await sendPeerFrame(
      started.socketPath!,
      peerFrame({ content: 'with the generated token' }),
      { authToken: token },
    );
    await sendPeerFrame(
      started.socketPath!,
      peerFrame({ content: 'with the generated child token' }),
      { authToken: childToken },
    );
    await settle();
    expect(submitted).toHaveLength(2);
    expect(submitted[0]).not.toContain('origin="own-process"');
    expect(submitted[1]).toContain('origin="own-process"');
  });

  it("delivers a child-token message the parity rule would hold, as the session's own", async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.YOLO);
    await send(m.socketPath!, peerFrame({ content: 'build finished' }), {
      authToken: TEST_CHILD_TOKEN,
    });
    await settle();
    expect(m.getHeld()).toHaveLength(0);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].modelText).toContain(
      '<cross_session_message from="own process" origin="own-process">',
    );
    expect(submitted[0].modelText).not.toContain('another Qwen Code session');
    expect(submitted[0].displayText).toBe(
      'Message from a process this session started (own process): build finished',
    );
  });

  it('holds the same frame when it arrives on the published token', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.YOLO);
    await send(
      m.socketPath!,
      peerFrame({ content: 'build finished', from: '/tmp/peer.sock' }),
    );
    await settle();
    expect(submitted).toHaveLength(0);
    expect(m.getHeld()).toHaveLength(1);
    expect(m.getHeld()[0].selfSent).toBeUndefined();
  });

  it('parks a child-token message under an explicit hold', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT, {
      getPolicySetting: () => 'hold',
    });
    await send(m.socketPath!, peerFrame({ content: 'build finished' }), {
      authToken: TEST_CHILD_TOKEN,
    });
    await settle();
    expect(submitted).toHaveLength(0);
    expect(m.getHeld()).toMatchObject([{ selfSent: true }]);
    // Released as itself: the envelope still says whose process it was.
    expect(m.decide(m.getHeld()[0].frame.msgId, 'approve')).toBe('done');
    expect(submitted[0].modelText).toContain('origin="own-process"');
  });

  it("keeps a child-token message's origin across the pre-submit buffer", async () => {
    // start() wires the submit function at once; here it is withheld so
    // the message waits in the buffer, and the origin must survive the wait.
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => undefined,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
      childToken: TEST_CHILD_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    await send(started.socketPath!, peerFrame({ content: 'early' }), {
      authToken: TEST_CHILD_TOKEN,
    });
    await settle();
    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('origin="own-process"');
  });

  it('keeps both origins when a later arrival retries a partial flush', async () => {
    const policy = { value: undefined as InboundPolicy | undefined };
    const started = await PeerMessaging.start({
      socketPath: path.join(tmpDir, 'socks', 'self.sock'),
      getApprovalMode: () => ApprovalMode.YOLO,
      getPolicySetting: () => policy.value,
      updateSessionRegistryIpcPath: async () => {},
      ipcToken: TEST_TOKEN,
      childToken: TEST_CHILD_TOKEN,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    await send(started.socketPath!, peerFrame({ content: 'buffered child' }), {
      authToken: TEST_CHILD_TOKEN,
    });
    await settle();
    policy.value = 'accept';
    await send(
      started.socketPath!,
      peerFrame({ content: 'buffered peer', from: '/tmp/peer.sock' }),
    );
    await settle();

    const submitted: string[] = [];
    let refuseOnce = true;
    started.setSubmitFn((modelText) => {
      if (refuseOnce) {
        refuseOnce = false;
        return false;
      }
      submitted.push(modelText);
      return true;
    });

    await send(
      started.socketPath!,
      peerFrame({ content: 'trigger drain', from: '/tmp/peer.sock' }),
    );
    await settle();

    expect(submitted).toHaveLength(3);
    expect(submitted[0]).toContain('buffered child');
    expect(submitted[0]).toContain('origin="own-process"');
    expect(submitted[1]).toContain('buffered peer');
    expect(submitted[1]).not.toContain('origin="own-process"');
  });
});

describe.skipIf(isWindows)('held message expiry', () => {
  it('reports the configured lifetime for the /peers listing', async () => {
    const { messaging } = await start(ApprovalMode.YOLO, {
      getPolicySetting: () => 'hold',
      getHeldExpiryMs: () => 90_000,
    });
    expect(messaging.getHeldExpiryMs()).toBe(90_000);
  });

  it('reports null when holds do not expire', async () => {
    const { messaging } = await start(ApprovalMode.YOLO, {
      getPolicySetting: () => 'hold',
      getHeldExpiryMs: () => null,
    });
    expect(messaging.getHeldExpiryMs()).toBeNull();
  });

  it('expires a held message and receipts the sender', async () => {
    const sender = await startSenderInbox();
    const { messaging, submitted } = await start(ApprovalMode.YOLO, {
      getPolicySetting: () => 'hold',
      // Real timers: the assertions below straddle a socket round trip,
      // so the window has to outlast `settle()` and still be short
      // enough to wait out.
      getHeldExpiryMs: () => 250,
    });

    await sendPeerFrame(
      messaging.socketPath!,
      buildUserFrame({ content: 'anyone there?', from: sender.socketPath }),
      { authToken: TEST_TOKEN },
    );
    await settle();
    expect(messaging.getHeld()).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();

    expect(messaging.getHeld()).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    const statuses = receipts
      .filter((frame) => frame.type === 'control')
      .map((frame) => (frame as { status: string }).status);
    expect(statuses).toContain('expired');
  });

  it('does not call a listing stale when only an expiry removed an entry', async () => {
    // The expiry timer is a fourth mover of the held set, alongside the
    // arrivals, evictions and releases the guard was written for. A
    // removal cannot make a printed handle resolve to a different
    // message -- `resolveHeld` prefix-matches over the current set, so
    // shrinking only narrows it -- and bouncing it refuses a decision
    // that would have been correct.
    const sender = await startSenderInbox();
    const { messaging } = await start(ApprovalMode.YOLO, {
      getPolicySetting: () => 'hold',
      getHeldExpiryMs: () => 250,
    });

    await sendPeerFrame(
      messaging.socketPath!,
      buildUserFrame({ content: 'first', from: sender.socketPath }),
      { authToken: TEST_TOKEN },
    );
    await settle();
    expect(messaging.getHeld()).toHaveLength(1);
    messaging.recordHeldListing(messaging.getHeld());
    expect(messaging.heldSetChangedSinceListing()).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    expect(messaging.getHeld()).toHaveLength(0);

    expect(messaging.heldSetChangedSinceListing()).toBe(false);
  });

  it('calls a listing stale when an expiry lets a handle reassign', async () => {
    // The exception to the rule above. `msgId` is peer-chosen and only
    // shape-checked, so a peer can park `abc` beside `abc12345`. While
    // both are held the handles are distinct and `resolveHeld`'s
    // exact-match tier gives `abc` to the shorter one. Once `abc`
    // expires, that handle falls through to prefix-matching and would
    // release `abc12345` -- a different message than the user reviewed.
    const sender = await startSenderInbox();
    const { messaging } = await start(ApprovalMode.YOLO, {
      getPolicySetting: () => 'hold',
      getHeldExpiryMs: () => 600,
    });

    await sendPeerFrame(
      messaging.socketPath!,
      {
        ...buildUserFrame({ content: 'short', from: sender.socketPath }),
        msgId: 'abc',
      },
      { authToken: TEST_TOKEN },
    );
    await settle();
    // Parked later, so it outlives the shorter id's window.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await sendPeerFrame(
      messaging.socketPath!,
      {
        ...buildUserFrame({ content: 'long', from: sender.socketPath }),
        msgId: 'abc12345',
      },
      { authToken: TEST_TOKEN },
    );
    await settle();
    expect(messaging.getHeld().map((e) => e.frame.msgId)).toEqual([
      'abc',
      'abc12345',
    ]);
    messaging.recordHeldListing(messaging.getHeld());
    expect(messaging.heldSetChangedSinceListing()).toBe(false);

    // `abc` ages past 600ms while `abc12345` has ~300ms left.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(messaging.getHeld().map((e) => e.frame.msgId)).toEqual(['abc12345']);

    expect(messaging.heldSetChangedSinceListing()).toBe(true);
  });

  it('receipts a refusal as refused rather than denied', async () => {
    const sender = await startSenderInbox();
    const { messaging } = await start(ApprovalMode.DEFAULT, {
      getPolicySetting: () => 'refuse',
    });

    await sendPeerFrame(
      messaging.socketPath!,
      buildUserFrame({ content: 'hello', from: sender.socketPath }),
      { authToken: TEST_TOKEN },
    );
    await settle();

    const statuses = receipts
      .filter((frame) => frame.type === 'control')
      .map((frame) => (frame as { status: string }).status);
    expect(statuses).toEqual(['refused']);
  });
});
