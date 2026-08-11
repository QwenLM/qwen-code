/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The startup window: frames that arrive while `PeerMessaging.start` is
 * still awaiting `startPeerInbox`.
 *
 * The socket accepts connections from `listen()` onward, but
 * `startPeerInbox` only resolves after it has chmod'd the socket — so
 * there is a real window in which `onFrame` fires before `start` returns.
 * These tests drive that window deterministically by having the mocked
 * `startPeerInbox` invoke `onFrame` before resolving, rather than racing a
 * real socket against a real bind.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PeerInbox, PeerUserFrame } from '@qwen-code/qwen-code-core';

const { startPeerInboxMock, patchSessionRecordMock, sendDeliveryStatusMock } =
  vi.hoisted(() => ({
    startPeerInboxMock: vi.fn(),
    patchSessionRecordMock: vi.fn(async () => {}),
    sendDeliveryStatusMock: vi.fn(async () => {}),
  }));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    startPeerInbox: startPeerInboxMock,
    patchSessionRecord: patchSessionRecordMock,
    sendDeliveryStatus: sendDeliveryStatusMock,
  };
});

const { ApprovalMode, buildUserFrame, resolvePeerSocketPath } = await import(
  '@qwen-code/qwen-code-core'
);
const { PeerMessaging } = await import('./peer-messaging.js');

const isWindows = process.platform === 'win32';
const describePosix = describe.skipIf(isWindows);
const SELF_SOCKET = resolvePeerSocketPath(456);
const PEER_SOCKET = resolvePeerSocketPath(123);

/** A frame that arrives during the bind window, before `start` resolves. */
function arriveDuringStartup(frame: PeerUserFrame): void {
  startPeerInboxMock.mockImplementation(
    async (options: { onFrame: (frame: PeerUserFrame) => void }) => {
      // Fires between `listen()` and `startPeerInbox` resolving — exactly
      // where a real peer's frame can land.
      options.onFrame(frame);
      const inbox: PeerInbox = {
        socketPath: SELF_SOCKET,
        close: async () => {},
      };
      return inbox;
    },
  );
}

function frame(): PeerUserFrame {
  return { ...buildUserFrame({ content: 'do a thing' }), from: PEER_SOCKET };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describePosix('PeerMessaging.start startup window', () => {
  it('gates a frame that arrives before the inbox finishes binding', async () => {
    const sent = frame();
    arriveDuringStartup(sent);

    const messaging = await PeerMessaging.start({
      socketPath: SELF_SOCKET,
      // Prompting receiver: the gate's policy is accept.
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
    });
    expect(messaging).not.toBeNull();

    // Accepted before the TUI existed, so it waits in the pre-submitFn
    // buffer rather than being dropped.
    const submitted: string[] = [];
    messaging!.setSubmitFn((modelText) => submitted.push(modelText));

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toContain('do a thing');
  });

  it('receipts a startup-window frame instead of dropping it silently', async () => {
    const sent = frame();
    arriveDuringStartup(sent);

    await PeerMessaging.start({
      socketPath: SELF_SOCKET,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
    });

    expect(sendDeliveryStatusMock).toHaveBeenCalledWith(
      PEER_SOCKET,
      expect.objectContaining({ status: 'delivered', origMsgId: sent.msgId }),
    );
  });

  it('does not send a receipt to an arbitrary local socket path', async () => {
    const sent = { ...frame(), from: '/tmp/unrelated.sock' };
    arriveDuringStartup(sent);

    await PeerMessaging.start({
      socketPath: SELF_SOCKET,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
    });

    expect(sendDeliveryStatusMock).not.toHaveBeenCalled();
  });

  it('does not send receipts when inbound messaging is refused', async () => {
    const sent = frame();
    arriveDuringStartup(sent);

    await PeerMessaging.start({
      socketPath: SELF_SOCKET,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => 'refuse',
    });

    expect(sendDeliveryStatusMock).not.toHaveBeenCalled();
  });

  it('holds a startup-window frame when the gate would hold it', async () => {
    const sent = frame();
    arriveDuringStartup(sent);

    // Mode unknown: the gate fails closed and parks the message.
    const messaging = await PeerMessaging.start({
      socketPath: SELF_SOCKET,
      getApprovalMode: () => null,
      getPolicySetting: () => undefined,
    });

    expect(messaging!.getHeld().map((entry) => entry.frame.msgId)).toEqual([
      sent.msgId,
    ]);
    expect(sendDeliveryStatusMock).toHaveBeenCalledWith(
      PEER_SOCKET,
      expect.objectContaining({ status: 'held', origMsgId: sent.msgId }),
    );
  });
});

describePosix('PeerMessaging.start when the bind fails after listen', () => {
  // `startPeerInbox` returns null after `listen()` when the socket chmod
  // fails. The gate has been wired since before the bind, so frames can
  // already have been admitted during the window — and `start()` must
  // settle them instead of walking away.
  function failAfterAdmitting(frame: PeerUserFrame): void {
    startPeerInboxMock.mockImplementation(
      async (options: { onFrame: (frame: PeerUserFrame) => void }) => {
        options.onFrame(frame);
        return null;
      },
    );
  }

  it('expires a held startup-window frame when the bind fails', async () => {
    const sent = frame();
    failAfterAdmitting(sent);

    const messaging = await PeerMessaging.start({
      socketPath: SELF_SOCKET,
      getApprovalMode: () => null,
      getPolicySetting: () => undefined,
    });

    expect(messaging).toBeNull();
    expect(sendDeliveryStatusMock).toHaveBeenCalledWith(
      PEER_SOCKET,
      expect.objectContaining({ status: 'held', origMsgId: sent.msgId }),
    );
    expect(sendDeliveryStatusMock).toHaveBeenCalledWith(
      PEER_SOCKET,
      expect.objectContaining({ status: 'expired', origMsgId: sent.msgId }),
    );
  });

  it('replaces the premature delivered receipt of a buffered frame', async () => {
    const sent = frame();
    failAfterAdmitting(sent);

    // Prompting receiver: the gate accepted the frame into the
    // pre-submitFn buffer and receipted it delivered at accept time.
    const messaging = await PeerMessaging.start({
      socketPath: SELF_SOCKET,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getPolicySetting: () => undefined,
    });

    expect(messaging).toBeNull();
    expect(sendDeliveryStatusMock).toHaveBeenCalledWith(
      PEER_SOCKET,
      expect.objectContaining({ status: 'delivered', origMsgId: sent.msgId }),
    );
    expect(sendDeliveryStatusMock).toHaveBeenCalledWith(
      PEER_SOCKET,
      expect.objectContaining({ status: 'expired', origMsgId: sent.msgId }),
    );
  });
});
