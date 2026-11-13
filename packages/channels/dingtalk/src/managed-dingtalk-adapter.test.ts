/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ManagedChannelControlPlane,
  ManagedClaimedDelivery,
  ManagedInboundEvent,
} from '@qwen-code/channel-base';
import {
  ManagedDingtalkAdapter,
  type ManagedDingtalkAdapterDeps,
  type DingtalkWebhookFailure,
} from './managed-dingtalk-adapter.js';

const CONFIG = {
  type: 'dingtalk',
  clientId: 'robot-app',
  clientSecret: 'secret',
  allowedUsers: ['staff-1'],
  dispatchMode: 'followup',
};

function messageData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    msgId: 'msg-1',
    msgtype: 'text',
    conversationId: 'conv-1',
    conversationType: '2',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
    senderStaffId: 'staff-1',
    senderNick: 'Alice',
    text: { content: 'hello agent' },
    ...overrides,
  });
}

function fakeControlPlane() {
  const register: unknown[] = [];
  const submit: ManagedInboundEvent[] = [];
  const receipts: Array<{ deliveryId: string; receipt: unknown }> = [];
  const admitted = new Map<string, string>();
  let queue: ManagedClaimedDelivery[] = [];
  let submitError: (Error & { status?: number; code?: string }) | undefined;
  let receiptError:
    | ((
        deliveryId: string,
      ) => (Error & { status?: number; code?: string }) | undefined)
    | undefined;
  const controlPlane: ManagedChannelControlPlane = {
    register: async (request) => {
      register.push(request);
    },
    disconnect: async () => {},
    submitInbound: async (event) => {
      if (submitError) {
        const error = submitError;
        submitError = undefined;
        throw error;
      }
      submit.push(event);
      const existing = admitted.get(event.platformEventId);
      if (existing)
        return { inputId: existing, sessionId: 'session-1', replayed: true };
      const inputId = `input-${admitted.size + 1}`;
      admitted.set(event.platformEventId, inputId);
      return { inputId, sessionId: 'session-1', replayed: false };
    },
    claimDeliveries: async () => queue.splice(0),
    receipt: async (deliveryId, receipt) => {
      const error = receiptError?.(deliveryId);
      if (error) throw error;
      receipts.push({ deliveryId, receipt });
    },
  };
  return {
    controlPlane,
    register,
    submit,
    receipts,
    enqueue: (deliveries: ManagedClaimedDelivery[]) => {
      queue = deliveries;
    },
    failNextSubmit: (error: Error & { status?: number; code?: string }) => {
      submitError = error;
    },
    setReceiptError: (
      fn:
        | ((
            deliveryId: string,
          ) => (Error & { status?: number; code?: string }) | undefined)
        | undefined,
    ) => {
      receiptError = fn;
    },
  };
}

function fakeDeps() {
  let handler: ((messageId: string, data: string) => void) | undefined;
  const sent: Array<{ webhook: string; text: string }> = [];
  let behavior: 'ok' | 'definitive' | 'transient' = 'ok';
  const deps: ManagedDingtalkAdapterDeps = {
    createStreamClient: (_settings, onMessage) => {
      handler = onMessage;
      return { connect: async () => {}, disconnect: () => {} };
    },
    sendWebhook: async (webhook, text) => {
      sent.push({ webhook, text });
      if (behavior !== 'ok') {
        const error = new Error(
          behavior === 'definitive' ? 'refused' : 'timeout',
        ) as DingtalkWebhookFailure;
        error.definitive = behavior === 'definitive';
        throw error;
      }
    },
    lock: async () => async () => {},
    now: () => 1_750_000_000_000,
    log: () => {},
  };
  return {
    deps,
    sent,
    push: (messageId: string, data: string) => handler!(messageId, data),
    setBehavior: (value: 'ok' | 'definitive' | 'transient') => {
      behavior = value;
    },
  };
}

function delivery(
  deliveryId: string,
  segments: number,
): ManagedClaimedDelivery {
  return {
    deliveryId,
    replyContext: {
      conversationId: 'conv-1',
      sessionWebhook:
        'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
      senderId: 'staff-1',
      robotCode: 'robot-app',
    },
    segments: Array.from({ length: segments }, (_, ordinal) => ({
      ordinal,
      segmentId: `${deliveryId}:${ordinal}`,
      text: `segment ${ordinal}`,
    })),
  };
}

const tempDirs: string[] = [];
function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'managed-dingtalk-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function connectedAdapter(cwd = tempCwd()) {
  const plane = fakeControlPlane();
  const fake = fakeDeps();
  const adapter = new ManagedDingtalkAdapter({
    name: 'ding-1',
    cwd,
    config: CONFIG,
    controlPlane: plane.controlPlane,
    deps: fake.deps,
    pollLoop: false,
  });
  await adapter.connect();
  return { adapter, plane, fake };
}

describe('managed DingTalk adapter inbound', () => {
  it('admits a robot message once and dedupes a redelivery', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('msg-1', messageData());
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.platformEventId).toBe('dingtalk:msg-1');
    expect(plane.submit[0]!.chatId).toBe('conv-1');
    expect(plane.submit[0]!.text).toBe('hello agent');
    expect(plane.submit[0]!.senderId).toBe('staff-1');
    // The same platform event redelivered admits nothing new.
    fake.push('msg-1', messageData());
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('skips a sender outside the allowlist', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'msg-2',
      messageData({ msgId: 'msg-2', senderStaffId: 'stranger' }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('skips a non-text message', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('msg-3', messageData({ msgId: 'msg-3', msgtype: 'picture' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('re-drives a lost admission answer without rebuilding the event', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.failNextSubmit(
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    fake.push('msg-4', messageData({ msgId: 'msg-4' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    // The claim survives; the next tick re-drives the identical event.
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.platformEventId).toBe('dingtalk:msg-4');
    await adapter.disconnect();
  });

  it('re-drives a persisted admission after a restart, without a stream redelivery', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.failNextSubmit(
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    first.fake.push('msg-9', messageData({ msgId: 'msg-9' }));
    await first.adapter.tick();
    expect(first.plane.submit).toHaveLength(0);
    await first.adapter.disconnect();

    // A fresh process loads the same state. The stream message was acked on
    // receipt and is never redelivered, so the re-drive must come from the
    // event persisted in the claim — nothing is pushed to this stream.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit).toHaveLength(1);
    expect(second.plane.submit[0]!.platformEventId).toBe('dingtalk:msg-9');
    expect(second.plane.submit[0]!.text).toBe('hello agent');
    expect(
      (second.plane.submit[0]!.replyContext as { conversationId: string })
        .conversationId,
    ).toBe('conv-1');
    await second.adapter.disconnect();
  });
});

describe('managed DingTalk adapter outbox', () => {
  it('sends each segment in order and receipts each by ordinal', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 3)]);
    await adapter.tick();
    expect(fake.sent.map((entry) => entry.text)).toEqual([
      'segment 0',
      'segment 1',
      'segment 2',
    ]);
    expect(plane.receipts).toHaveLength(3);
    expect(
      plane.receipts.map(
        (entry) => (entry.receipt as { ordinal: number }).ordinal,
      ),
    ).toEqual([0, 1, 2]);
    expect(
      plane.receipts.every(
        (entry) =>
          (entry.receipt as { outcome: string }).outcome === 'accepted',
      ),
    ).toBe(true);
    await adapter.disconnect();
  });

  it('reports a definitive webhook refusal as rejected and never resends', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.setBehavior('definitive');
    plane.enqueue([delivery('d-2', 1)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(1);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'rejected',
    );
    // A later tick re-drives the persisted receipt, never the send.
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    await adapter.disconnect();
  });

  it('reports a transient webhook failure as unknown and never resends', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.setBehavior('transient');
    plane.enqueue([delivery('d-3', 1)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'unknown',
    );
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    await adapter.disconnect();
  });

  it('rejects a delivery whose committed target is missing', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const broken = delivery('d-4', 1);
    broken.replyContext = {
      conversationId: '',
      sessionWebhook: '',
      senderId: 'staff-1',
      robotCode: 'robot-app',
    };
    plane.enqueue([broken]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(0);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'rejected',
    );
    await adapter.disconnect();
  });

  it('uses the newest webhook learned from a later inbound message', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'msg-5',
      messageData({
        msgId: 'msg-5',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/sendBySession?session=new',
      }),
    );
    await adapter.tick();
    plane.enqueue([delivery('d-5', 1)]);
    await adapter.tick();
    expect(fake.sent[0]!.webhook).toBe(
      'https://oapi.dingtalk.com/robot/sendBySession?session=new',
    );
    await adapter.disconnect();
  });

  it('drops a deterministically refused orphan receipt without wedging later ones', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // Both sends land but their receipt answers are lost: both entries stay
    // outbound, each with a persisted accepted receipt.
    plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    plane.enqueue([delivery('d-A', 1), delivery('d-B', 1)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(2);
    expect(plane.receipts).toHaveLength(0);
    // d-A is now deterministically refused; d-B can settle. The dropped d-A
    // must not block d-B, which sits behind it in the orphan queue.
    plane.setReceiptError((id) =>
      id === 'd-A'
        ? Object.assign(new Error('gone'), {
            status: 404,
            code: 'delivery_not_found',
          })
        : undefined,
    );
    await adapter.tick();
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual(['d-B']);
    await adapter.disconnect();
  });

  it('re-registers after an orphan receipt is refused as not registered', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    plane.enqueue([delivery('d-R', 1)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(0);
    const registersBefore = plane.register.length;
    plane.setReceiptError(() =>
      Object.assign(new Error('not registered'), {
        status: 404,
        code: 'channel_not_found',
      }),
    );
    await adapter.tick();
    // The entry is kept and the generation reset; the next tick re-registers
    // first, then the re-driven receipt settles.
    plane.setReceiptError(undefined);
    await adapter.tick();
    expect(plane.register.length).toBeGreaterThan(registersBefore);
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual(['d-R']);
    await adapter.disconnect();
  });
});
