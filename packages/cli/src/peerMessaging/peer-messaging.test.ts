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
  sendPeerFrame,
  startPeerInbox,
  type PeerFrame,
  type PeerInbox,
} from '@qwen-code/qwen-code-core';
import {
  MAX_ACCEPTED_BACKLOG,
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
    ) =>
      | { address: string; peerName: string; previous: 'pending' | 'held' }
      | undefined;
    reassertSessionRecord?: () => Promise<void>;
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({
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
              peerName: 'docs-cd',
              previous: 'pending',
            }
          : undefined,
    });
    const seen: Array<{ status: string; address: string; origMsgId: string }> =
      [];
    m.onReceipt((receipt) => seen.push(receipt));

    await sendPeerFrame(
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

    await sendPeerFrame(
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

    await sendPeerFrame(
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

  it('keeps delivering receipts when one listener throws', async () => {
    const { messaging: m } = await start(ApprovalMode.DEFAULT, {
      settleSentMessage: () => ({
        address: 'docs-cd',
        peerName: 'docs-cd',
        previous: 'pending',
      }),
    });
    const seen: unknown[] = [];
    m.onReceipt(() => {
      throw new Error('listener bug');
    });
    m.onReceipt((receipt) => seen.push(receipt));

    await sendPeerFrame(
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
    const frame = buildUserFrame({
      content: 'meant for whoever had this pid before',
      from: sender.socketPath,
      toSessionId: 'session-before',
    });
    await sendPeerFrame(m.socketPath!, frame);
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({
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
      getSessionId: () => 'session-now',
    });
    // Wait until the listener exists and its chmod is being held.
    for (let i = 0; i < 100 && chmodControl.release === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (chmodControl.release === null) throw new Error('chmod hold missed');
    const frame = buildUserFrame({
      content: 'early and misaddressed',
      from: sender.socketPath,
      toSessionId: 'session-before',
    });
    await sendPeerFrame(path.join(tmpDir, 'socks', 'self.sock'), frame);
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({ content: 'hello', from: '/tmp/peer.sock' }),
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({
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
      getSessionId: () => current,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    const frame = buildUserFrame({
      content: 'held before /clear',
      from: sender.socketPath,
      fromMode: 'prompting',
      toSessionId: 'session-a',
    });
    await sendPeerFrame(started.socketPath!, frame);
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
      getSessionId: () => current,
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    const queued: PeerQueuedDelivery[] = [];
    started.setSubmitFn((_modelText, _displayText, delivery) => {
      if (delivery) queued.push(delivery);
      return true;
    });
    const frame = buildUserFrame({
      content: 'queued before /clear',
      from: sender.socketPath,
      toSessionId: 'session-a',
    });
    await sendPeerFrame(started.socketPath!, frame);
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({ content: 'run the deploy', from: '/tmp/peer.sock' }),
    );
    await settle();

    expect(submitted).toHaveLength(0);
    expect(m.getHeld()).toHaveLength(1);
    expect(m.getHeld()[0].cause).toBe('no-mode-asserted');
  });

  it('releases a held message when approved', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.YOLO);
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({ content: 'run the deploy', from: '/tmp/peer.sock' }),
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
    });

    await vi.waitFor(() => {
      expect(fsSync.existsSync(socketPath)).toBe(true);
    });
    await sendPeerFrame(
      socketPath,
      buildUserFrame({ content: 'early frame', from: '/tmp/peer.sock' }),
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
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    await sendPeerFrame(
      started.socketPath!,
      buildUserFrame({ content: 'early bird', from: '/tmp/peer.sock' }),
    );
    await settle();

    const submitted: string[] = [];
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('early bird');
  });

  it('sends a delivery receipt back to the sender', async () => {
    const sender = await startSenderInbox();
    const { messaging: m } = await start(ApprovalMode.DEFAULT);

    const frame = buildUserFrame({
      content: 'hi',
      from: sender.socketPath,
    });
    await sendPeerFrame(m.socketPath!, frame);
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

    const frame = buildUserFrame({ content: 'hi', from: sender.socketPath });
    await sendPeerFrame(m.socketPath!, frame);
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

    const frame = buildUserFrame({ content: 'hi', from: sender.socketPath });
    await sendPeerFrame(m.socketPath!, frame);
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
      sendPeerFrame(m.socketPath!, buildUserFrame({ content: 'anonymous' })),
    ).resolves.toBeUndefined();
    await settle();
    expect(receipts).toHaveLength(0);
  });

  it('ignores an inbound control frame instead of treating it as a message', async () => {
    const { messaging: m, submitted } = await start(ApprovalMode.DEFAULT);
    await sendPeerFrame(m.socketPath!, {
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
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    started.setSubmitFn((modelText) => {
      submitted.push(modelText);
      return true;
    });

    await sendPeerFrame(
      started.socketPath!,
      buildUserFrame({ content: 'later', from: '/tmp/peer.sock' }),
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
    await sendPeerFrame(
      m.socketPath!,
      buildUserFrame({ content: 'early hold', from: '/tmp/peer.sock' }),
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
      await sendPeerFrame(
        started.socketPath!,
        buildUserFrame({ content: `flood ${i}`, from: sender.socketPath }),
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
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const overflow = 5;
    for (let i = 0; i < MAX_ACCEPTED_BACKLOG + overflow; i++) {
      await sendPeerFrame(
        started.socketPath!,
        buildUserFrame({ content: `early ${i}`, from: sender.socketPath }),
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
      await sendPeerFrame(
        m.socketPath!,
        buildUserFrame({ content: `hold ${i}`, from: sender.socketPath }),
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
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    // No submit function wired: the frame is accepted into the buffer.

    const frame = buildUserFrame({
      content: 'early bird',
      from: sender.socketPath,
    });
    await sendPeerFrame(started.socketPath!, frame);
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
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const queued: string[] = [];
    started.setSubmitFn((modelText) => {
      queued.push(modelText);
      return true;
    });
    started.setQueuedPeerCount(() => queued.length);

    const consumed = buildUserFrame({
      content: 'consumed',
      from: sender.socketPath,
    });
    const waiting = buildUserFrame({
      content: 'waiting',
      from: sender.socketPath,
    });
    await sendPeerFrame(started.socketPath!, consumed);
    await sendPeerFrame(started.socketPath!, waiting);
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
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;

    const frames = [0, 1, 2].map((i) =>
      buildUserFrame({ content: `mixed ${i}`, from: sender.socketPath }),
    );
    for (const frame of frames) {
      await sendPeerFrame(started.socketPath!, frame);
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
    });
    if (!started) throw new Error('peer messaging failed to start');
    messaging = started;
    started.setSubmitFn(() => true);

    const target = buildUserFrame({
      content: 'BODY-1',
      from: sender.socketPath,
    });
    await sendPeerFrame(started.socketPath!, target);
    await settle();
    started.recordHeldListing(started.getHeld());

    // Evict the target with newer holds, then release them again.
    for (let i = 0; i < MAX_HELD_MESSAGES; i++) {
      await sendPeerFrame(
        started.socketPath!,
        buildUserFrame({ content: `evict ${i}`, from: sender.socketPath }),
      );
    }
    mode = ApprovalMode.DEFAULT;
    started.reevaluate('test');
    expect(started.getHeld()).toHaveLength(0);

    // Prune the target's tombstone with MAX_SETTLED_IDS fresh settlements.
    for (let i = 0; i < MAX_SETTLED_IDS; i++) {
      await sendPeerFrame(
        started.socketPath!,
        buildUserFrame({ content: `churn ${i}`, from: sender.socketPath }),
      );
    }

    // The id is re-admittable now; ids and order match the old listing.
    mode = ApprovalMode.YOLO;
    await sendPeerFrame(started.socketPath!, {
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
