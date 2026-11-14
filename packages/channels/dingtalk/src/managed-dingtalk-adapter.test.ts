/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    conversationType: '1',
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
  let refuseSubmit: { status: number; code?: string } | undefined;
  let submitErrorFor:
    | ((
        eventId: string,
      ) => (Error & { status?: number; code?: string }) | undefined)
    | undefined;
  let submitAttempts = 0;
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
      submitAttempts += 1;
      const perEvent = submitErrorFor?.(event.platformEventId);
      if (perEvent) throw perEvent;
      if (refuseSubmit) {
        throw Object.assign(new Error(`HTTP ${refuseSubmit.status}`), {
          status: refuseSubmit.status,
          code: refuseSubmit.code,
        });
      }
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
    submitAttempts: () => submitAttempts,
    setRefuseSubmit: (value: { status: number; code?: string } | undefined) => {
      refuseSubmit = value;
    },
    setSubmitErrorFor: (
      fn:
        | ((
            eventId: string,
          ) => (Error & { status?: number; code?: string }) | undefined)
        | undefined,
    ) => {
      submitErrorFor = fn;
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
  let handler: ((messageId: string, data: string) => boolean) | undefined;
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
// The state store lives under getGlobalQwenDir(), not the workspace cwd; keep
// it inside the sandbox so a run never writes channel state (with live
// sessionWebhook URLs) into the real global Qwen directory.
beforeEach(() => {
  vi.stubEnv('QWEN_HOME', tempCwd());
});
afterEach(() => {
  vi.unstubAllEnvs();
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

  it('truncates an over-long inbound text to the wire bound instead of dropping it', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'msg-long',
      messageData({ msgId: 'msg-long', text: { content: 'x'.repeat(32_001) } }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.text).toHaveLength(32_000);
    await adapter.disconnect();
  });

  it('clamps a CJK text to the byte envelope even under the character bound', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // 25,000 CJK characters are under the 32,000-character line but ~75 KB in
    // UTF-8, over the 64 KiB envelope: the byte cut must land on a code point.
    fake.push(
      'msg-cjk',
      messageData({ msgId: 'msg-cjk', text: { content: '中'.repeat(25_000) } }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
      64 * 1024 - 4096,
    );
    expect(text.length).toBeLessThan(25_000);
    expect(text).toBe('中'.repeat(text.length));
    await adapter.disconnect();
  });

  it('drops a deterministically refused admission visibly, never re-driving it', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 400 });
    fake.push('msg-poison', messageData({ msgId: 'msg-poison' }));
    await adapter.tick();
    expect(plane.submitAttempts()).toBe(1);
    expect(plane.submit).toHaveLength(0);
    // The claim is gone, so a later tick never re-drives it.
    await adapter.tick();
    expect(plane.submitAttempts()).toBe(1);
    // The rest of the inbound still flows once the refusal clears.
    plane.setRefuseSubmit(undefined);
    fake.push('msg-fine', messageData({ msgId: 'msg-fine' }));
    await adapter.tick();
    expect(plane.submitAttempts()).toBe(2);
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:msg-fine',
    ]);
    await adapter.disconnect();
  });

  it('re-registers after an admission is refused as not registered, keeping the event', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.failNextSubmit(
      Object.assign(new Error('not registered'), {
        status: 404,
        code: 'channel_not_found',
      }),
    );
    fake.push('msg-reg', messageData({ msgId: 'msg-reg' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    const registersBefore = plane.register.length;
    // The claim is kept and the generation reset; the next tick re-registers
    // first, then re-drives the identical event.
    await adapter.tick();
    expect(plane.register.length).toBeGreaterThan(registersBefore);
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:msg-reg',
    ]);
    await adapter.disconnect();
  });

  it('stalls admission on consecutive workspace_not_found refusals instead of dropping every message', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m1', messageData({ msgId: 'm1', text: { content: 'first' } }));
    fake.push('m2', messageData({ msgId: 'm2', text: { content: 'second' } }));
    fake.push('m3', messageData({ msgId: 'm3', text: { content: 'third' } }));
    await adapter.tick();
    // The first refusal drops as the sacrifice; the second holds and stalls,
    // so the third message is never attempted.
    expect(plane.submitAttempts()).toBe(2);
    expect(plane.submit).toHaveLength(0);
    // During the stall the gate refuses new frames, leaving them unacked for
    // provider redelivery instead of acked-and-parked in memory.
    expect(
      fake.push(
        'm4',
        messageData({ msgId: 'm4', text: { content: 'fourth' } }),
      ),
    ).toBe(false);
    await adapter.tick();
    // One held-claim probe per tick; the mail behind the stall stays unattempted.
    expect(plane.submitAttempts()).toBe(3);
    expect(plane.submit).toHaveLength(0);
    // The binding answers again: the held claim and the backlog flow. m3 was
    // persisted as a claim when the stall armed, so this tick lifts the stall
    // and re-drives it from pending; m4 is then redelivered by the provider (it
    // was left unacked during the stall) and admitted on the next tick.
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    fake.push('m4', messageData({ msgId: 'm4', text: { content: 'fourth' } }));
    await adapter.tick();
    expect(plane.submit.map((event) => event.text)).toEqual([
      'second',
      'third',
      'fourth',
    ]);
    await adapter.disconnect();
  });

  it('restores the workspace stall from the persisted held claim across a restart', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    first.fake.push(
      'm1',
      messageData({ msgId: 'm1', text: { content: 'first' } }),
    );
    first.fake.push(
      'm2',
      messageData({ msgId: 'm2', text: { content: 'held' } }),
    );
    await first.adapter.tick();
    expect(first.plane.submitAttempts()).toBe(2);
    await first.adapter.disconnect();

    // The restart re-arms the stall from the persisted held marker. The held
    // re-drive meets a transient 503 (no verdict) while new mail arrives behind
    // the stall — that mail must not be admitted to the still-broken binding.
    const second = await connectedAdapter(cwd);
    second.plane.setRefuseSubmit({ status: 503 });
    // The re-armed stall refuses new frames at the gate (left unacked).
    expect(
      second.fake.push(
        'm3',
        messageData({ msgId: 'm3', text: { content: 'behind' } }),
      ),
    ).toBe(false);
    await second.adapter.tick();
    expect(second.plane.submitAttempts()).toBe(1);
    expect(second.plane.submit).toHaveLength(0);
    // The binding answers again: this tick lifts the stall and admits the held
    // claim; the mail behind it is then redelivered by the provider (it was left
    // unacked during the stall) and admitted on the next tick.
    second.plane.setRefuseSubmit(undefined);
    await second.adapter.tick();
    second.fake.push(
      'm3',
      messageData({ msgId: 'm3', text: { content: 'behind' } }),
    );
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual([
      'held',
      'behind',
    ]);
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

  it('replays the persisted provider receipt on restart instead of settling unknown', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // The webhook accepted the segment and the receipt was persisted — only
    // the control plane's answer was lost.
    first.plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    first.plane.enqueue([delivery('d-receipted', 1)]);
    await first.adapter.tick();
    expect(first.fake.sent).toHaveLength(1);
    expect(first.plane.receipts).toHaveLength(0);
    await first.adapter.disconnect();

    // The restart replays the committed accepted receipt verbatim, never a
    // blanket unknown, and never re-sends the segment.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.receipts).toHaveLength(1);
    expect(second.plane.receipts[0]!.deliveryId).toBe('d-receipted');
    expect(
      (second.plane.receipts[0]!.receipt as { outcome: string }).outcome,
    ).toBe('accepted');
    expect(second.fake.sent).toHaveLength(0);
    await second.adapter.disconnect();
  });

  it('rejects a delivery whose conversation has no webhook without sending', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const noWebhook = delivery('d-nowebhook', 1);
    noWebhook.replyContext = {
      conversationId: 'conv-unknown',
      sessionWebhook: '',
      senderId: 'staff-1',
      robotCode: 'robot-app',
    };
    plane.enqueue([noWebhook]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(0);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'rejected',
    );
    await adapter.disconnect();
  });

  it('refuses a reply whose sender the policy does not allow without sending', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const foreign = delivery('d-foreign', 1);
    foreign.replyContext = {
      conversationId: 'conv-1',
      sessionWebhook:
        'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
      senderId: 'mallory',
      robotCode: 'robot-app',
    };
    plane.enqueue([foreign]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(0);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'rejected',
    );
    await adapter.disconnect();
  });

  it('stops the rest of a multi-segment delivery after a non-accepted segment', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.setBehavior('definitive');
    plane.enqueue([delivery('d-multi', 3)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(1);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'rejected',
    );
    await adapter.disconnect();
  });
});

describe('managed DingTalk adapter review fixes', () => {
  it('drops a group frame under the private-chat policy (R1-7)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'msg-group',
      messageData({ msgId: 'msg-group', conversationType: '2' }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('re-registers after a 409 channel_disconnected refusal, keeping the event (R1-1)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.failNextSubmit(
      Object.assign(new Error('disconnected'), {
        status: 409,
        code: 'channel_disconnected',
      }),
    );
    fake.push('msg-409', messageData({ msgId: 'msg-409' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    const registersBefore = plane.register.length;
    await adapter.tick();
    expect(plane.register.length).toBeGreaterThan(registersBefore);
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:msg-409',
    ]);
    await adapter.disconnect();
  });

  it('persists acked-but-unadmitted inbox messages on disconnect (R1-5)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.fake.push('msg-shutdown', messageData({ msgId: 'msg-shutdown' }));
    // No tick: the message is acked and parked in the in-memory inbox.
    await first.adapter.disconnect();
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:msg-shutdown',
    ]);
    await second.adapter.disconnect();
  });

  it('drops a persisted claim whose sender the restarted policy revoked (R1-8)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.failNextSubmit(
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    first.fake.push('msg-rev', messageData({ msgId: 'msg-rev' }));
    await first.adapter.tick();
    expect(first.plane.submit).toHaveLength(0);
    await first.adapter.disconnect();

    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const second = new ManagedDingtalkAdapter({
      name: 'ding-1',
      cwd,
      config: { ...CONFIG, allowedUsers: [] },
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await second.connect();
    await second.tick();
    expect(plane.submit).toHaveLength(0);
    await second.disconnect();
  });

  it('lifts the stall when the held claim drops on a per-message verdict (R1-2)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('h1', messageData({ msgId: 'h1' }));
    fake.push('h2', messageData({ msgId: 'h2' }));
    await adapter.tick(); // h1 sacrificed, h2 held, admission stalled
    plane.setRefuseSubmit({ status: 400 });
    await adapter.tick(); // h2 drops on the per-message verdict, stall lifts
    plane.setRefuseSubmit(undefined);
    fake.push('h3', messageData({ msgId: 'h3' }));
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:h3',
    ]);
    await adapter.disconnect();
  });

  it('probes the held claim before an unheld claim that never settles (R1-3)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const lost = () => Object.assign(new Error('answer lost'), { status: 503 });
    plane.setSubmitErrorFor((id) => (id === 'dingtalk:X' ? lost() : undefined));
    fake.push('X', messageData({ msgId: 'X' }));
    await adapter.tick(); // X stays pending, unheld
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('A', messageData({ msgId: 'A' }));
    fake.push('H', messageData({ msgId: 'H' }));
    await adapter.tick(); // A sacrificed, H held, stalled; pending = [X, H]
    plane.setRefuseSubmit(undefined);
    await adapter.tick(); // held-first probes H, whose success lifts the stall
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:H',
    ]);
    await adapter.disconnect();
  });

  it('the shutdown drain never evicts an already-persisted claim (R2-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.setRefuseSubmit({ status: 503 });
    for (let i = 1; i <= 32; i += 1) {
      first.fake.push(`m${i}`, messageData({ msgId: `m${i}` }));
    }
    await first.adapter.tick(); // pending fills to the 32-claim cap
    first.fake.push('m33', messageData({ msgId: 'm33' })); // parks in the inbox
    await first.adapter.disconnect(); // bounded drain must not evict m1

    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.platformEventId)).toContain(
      'dingtalk:m1',
    );
    await second.adapter.disconnect();
  });

  it('clamps escape-heavy text by its JSON-serialized length (R3-2)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // 32,000 U+0001 control chars are 32,000 raw bytes but ~192 KB once
    // JSON-escaped; the clamp must budget the escaped length, not the raw one.
    fake.push(
      'msg-esc',
      messageData({
        msgId: 'msg-esc',
        text: { content: '\u0001'.repeat(32_000) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    expect(Buffer.byteLength(JSON.stringify(text), 'utf8')).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(text.length).toBeLessThan(32_000);
    await adapter.disconnect();
  });

  it('does not admit a lone surrogate at the character-cap boundary (F1)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // 31,001 ASCII + 1,000 emoji: the 32,000-UTF-16-unit cap lands inside a
    // surrogate pair; the admitted text must stay well-formed.
    fake.push(
      'msg-astral',
      messageData({
        msgId: 'msg-astral',
        text: { content: 'x'.repeat(31_001) + '😀'.repeat(1_000) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.text.isWellFormed()).toBe(true);
    await adapter.disconnect();
  });

  it('acks only when a durable claim slot exists (R4-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.setRefuseSubmit({ status: 503 });
    for (let i = 1; i <= 32; i += 1) {
      first.fake.push(`m${i}`, messageData({ msgId: `m${i}` }));
    }
    await first.adapter.tick(); // pending fills to the 32-claim cap
    // The 33rd frame has no durable claim slot: it must be left unacked for
    // provider redelivery, not acked and parked in memory to be discarded.
    const accepted = first.fake.push('m33', messageData({ msgId: 'm33' }));
    expect(accepted).toBe(false);
    await first.adapter.disconnect();
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(
      second.plane.submit.map((event) => event.platformEventId),
    ).not.toContain('dingtalk:m33');
    await second.adapter.disconnect();
  });

  it('a refused rejection receipt does not abort the claimed batch (R5-3)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // d-targetless has no usable target (takes the rejection arm); d-behind is
    // sendable and sits behind it in the same claimed batch.
    const targetless = delivery('d-targetless', 1);
    targetless.replyContext = {
      conversationId: '',
      sessionWebhook: '',
      senderId: 'staff-1',
      robotCode: 'robot-app',
    };
    plane.enqueue([targetless, delivery('d-behind', 1)]);
    plane.setReceiptError((id) =>
      id === 'd-targetless'
        ? Object.assign(new Error('refused'), { status: 500 })
        : undefined,
    );
    await adapter.tick();
    // The rejection receipt is refused, but the delivery behind it must still
    // send — the tick must not escape and settle the whole batch unknown.
    expect(fake.sent.map((entry) => entry.text)).toEqual(['segment 0']);
    await adapter.disconnect();
  });

  it('persists the acked inbox backlog when the stall arms, so a hard restart re-drives it (R5-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    // Three frames are acked into the inbox before the stall arms.
    first.fake.push(
      'm1',
      messageData({ msgId: 'm1', text: { content: 'first' } }),
    );
    first.fake.push(
      'm2',
      messageData({ msgId: 'm2', text: { content: 'second' } }),
    );
    first.fake.push(
      'm3',
      messageData({ msgId: 'm3', text: { content: 'third' } }),
    );
    await first.adapter.tick();
    // m1 drops as the sacrifice, m2 holds and arms the stall. m3 was already
    // acked; it must be persisted as a claim even though admission is stalled.
    expect(first.plane.submitAttempts()).toBe(2);
    // Hard restart: no graceful disconnect, so drainInboxOnShutdown never runs
    // and the first adapter is abandoned mid-stall. A fresh process reads only
    // what was persisted to the state file — an in-memory inbox frame is lost.
    const second = await connectedAdapter(cwd);
    second.plane.setRefuseSubmit(undefined);
    await second.adapter.tick();
    // The held claim and the acked backlog both re-drive from durable state.
    expect(second.plane.submit.map((event) => event.text)).toEqual([
      'second',
      'third',
    ]);
    await second.adapter.disconnect();
  });
});
