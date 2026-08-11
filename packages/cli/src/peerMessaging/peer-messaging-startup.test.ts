/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  frame: {
    msgV: 1 as const,
    msgId: 'startup-frame',
    type: 'user' as const,
    priority: 'next' as const,
    from: '/tmp/sender.sock',
    message: { role: 'user' as const, content: 'arrived during bind' },
  },
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  approvalModeClass: () => 'prompting',
  createDebugLogger: () => ({ warn: vi.fn() }),
  formatPeerDisplay: ({ content }: { content: string }) => content,
  formatPeerEnvelope: ({ content }: { content: string }) => content,
  InboundGate: class {
    constructor(
      private readonly options: {
        deliver: (frame: typeof startup.frame) => void;
        reportStatus: (
          frame: typeof startup.frame,
          status: 'delivered',
        ) => void;
      },
    ) {}

    admit(frame: typeof startup.frame) {
      this.options.deliver(frame);
      this.options.reportStatus(frame, 'delivered');
    }

    getHeld() {
      return [];
    }
  },
  MAX_HELD_MESSAGES: 50,
  patchSessionRecord: vi.fn(),
  sendDeliveryStatus: vi.fn(async () => undefined),
  startPeerInbox: vi.fn(
    async ({ onFrame }: { onFrame: (frame: typeof startup.frame) => void }) => {
      onFrame(startup.frame);
      return {
        socketPath: '/tmp/self.sock',
        close: vi.fn(),
      };
    },
  ),
}));

import { PeerMessaging } from './peer-messaging.js';

describe('PeerMessaging startup', () => {
  it('buffers a frame accepted before the inbox promise resolves', async () => {
    const messaging = await PeerMessaging.start({
      getApprovalMode: () => null,
      getPolicySetting: () => undefined,
    });
    if (!messaging) throw new Error('expected messaging to start');

    const submitted: string[] = [];
    messaging.setSubmitFn((modelText) => submitted.push(modelText));

    expect(submitted).toEqual(['arrived during bind']);
  });
});
