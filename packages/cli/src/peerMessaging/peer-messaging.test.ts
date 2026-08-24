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
  buildUserFrame,
  sendPeerFrame,
  startPeerInbox,
  type PeerFrame,
  type PeerInbox,
} from '@qwen-code/qwen-code-core';
import { MAX_ACCEPTED_BACKLOG, PeerMessaging } from './peer-messaging.js';

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

  it('is safe to close twice', async () => {
    const { messaging: m } = await start();
    await m.close();
    await expect(m.close()).resolves.toBeUndefined();
    messaging = null;
  });
});
