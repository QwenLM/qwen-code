/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_INBOUND_TRUNCATION_NOTICE,
  MANAGED_OUTBOUND_LIMIT,
  type ManagedChannelControlPlane,
  type ManagedClaimedDelivery,
  type ManagedInboundEvent,
} from '@qwen-code/channel-base';
import {
  ManagedDingtalkAdapter,
  dingtalkSettings,
  type ManagedDingtalkAdapterDeps,
  type DingtalkWebhookFailure,
} from './managed-dingtalk-adapter.js';
import {
  MANAGED_DINGTALK_PENDING_LIMIT,
  RECENT_LIMIT,
  WEBHOOK_LIMIT,
} from './managed-state.js';

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
  let disconnectCalls = 0;
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
    disconnect: async () => {
      disconnectCalls += 1;
    },
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
    disconnectCalls: () => disconnectCalls,
    enqueue: (deliveries: ManagedClaimedDelivery[]) => {
      queue = deliveries;
    },
    failNextSubmit: (error: Error & { status?: number; code?: string }) => {
      submitError = error;
    },
    submitAttempts: () => submitAttempts,
    // Simulate an admission the server committed but whose answer was lost:
    // the next re-submission of this event answers replayed, not fresh.
    markAdmitted: (eventId: string) => {
      admitted.set(eventId, `input-${admitted.size + 1}`);
    },
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

function fakeDeps(
  hooks: { log?: (line: string) => void; beforeSend?: () => void } = {},
) {
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
      hooks.beforeSend?.();
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
    log: hooks.log ?? (() => {}),
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

async function connectedAdapter(
  cwd = tempCwd(),
  hooks: { log?: (line: string) => void; beforeSend?: () => void } = {},
) {
  const plane = fakeControlPlane();
  const fake = fakeDeps(hooks);
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

  it('registers the dingtalk platform, clientId account and resolved policy (R1-19)', async () => {
    const { adapter, plane } = await connectedAdapter();
    expect(plane.register).toHaveLength(1);
    expect(plane.register[0]).toEqual({
      platform: 'dingtalk',
      accountId: 'robot-app',
      accountGeneration: 1,
      policy: {
        adapter: 'dingtalk',
        senderPolicy: 'allowlist',
        allowedSenders: ['staff-1'],
        dispatchMode: 'followup',
      },
    });
    await adapter.disconnect();
  });

  it('admits only frames with a usable reply target (R1-32)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // A conversationId naming an Object.prototype member must not resolve on
    // an empty cache (R2-2): without own-key membership the inherited value
    // reads truthy and the frame would be admitted.
    fake.push(
      'proto',
      messageData({
        msgId: 'proto',
        conversationId: 'constructor',
        sessionWebhook: '',
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    // No committed webhook and none cached: the frame can never be answered,
    // so it is dropped at admission rather than staged as a claim.
    fake.push('no-hook', messageData({ msgId: 'no-hook', sessionWebhook: '' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    // A later frame commits a webhook for the conversation; a subsequent frame
    // without its own webhook is admitted against the cached target.
    fake.push('with-hook', messageData({ msgId: 'with-hook' }));
    await adapter.tick();
    fake.push(
      'cached-hook',
      messageData({ msgId: 'cached-hook', sessionWebhook: '' }),
    );
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:with-hook',
      'dingtalk:cached-hook',
    ]);
    await adapter.disconnect();
  });

  it('a group frame does not spend the webhook cache budget (R3-2)', async () => {
    const { adapter, fake } = await connectedAdapter();
    fake.push(
      'priv',
      messageData({ msgId: 'priv', conversationId: 'conv-private' }),
    );
    await adapter.tick();
    // A group frame carrying a webhook must be dropped without caching it.
    fake.push(
      'grp',
      messageData({
        msgId: 'grp',
        conversationId: 'conv-group',
        conversationType: '2',
      }),
    );
    await adapter.tick();
    const store = (adapter as unknown as { store: { file: string } }).store;
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(Object.hasOwn(persisted.webhooks, 'conv-group')).toBe(false);
    expect(Object.hasOwn(persisted.webhooks, 'conv-private')).toBe(true);
    await adapter.disconnect();
  });

  it('a refused sender does not spend the webhook cache budget (R4-2)', async () => {
    const { adapter, fake } = await connectedAdapter();
    // An intruder outside the allowlist DMs with a webhook; the frame must be
    // dropped without caching its conversation.
    fake.push(
      'intruder',
      messageData({
        msgId: 'intruder',
        conversationId: 'conv-intruder',
        senderStaffId: 'intruder',
      }),
    );
    await adapter.tick();
    const store = (adapter as unknown as { store: { file: string } }).store;
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(Object.hasOwn(persisted.webhooks, 'conv-intruder')).toBe(false);
    await adapter.disconnect();
  });

  it('a frame admitted on a cached webhook snapshots it into the claim (R3-3)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'first',
      messageData({ msgId: 'first', conversationId: 'conv-A' }),
    );
    await adapter.tick();
    fake.push(
      'second',
      messageData({
        msgId: 'second',
        conversationId: 'conv-A',
        sessionWebhook: '',
      }),
    );
    await adapter.tick();
    const second = plane.submit.find(
      (event) => event.platformEventId === 'dingtalk:second',
    );
    expect(
      (second!.replyContext as { sessionWebhook: string }).sessionWebhook,
    ).toBe('https://oapi.dingtalk.com/robot/sendBySession?session=abc');
    await adapter.disconnect();
  });

  // The fill drives 780 fsync-backed state writes, so disk latency decides the
  // runtime: the same sequence measured 1.6ms and 14ms per write minutes apart
  // on one host, and 38ms per write outlasts the old flat 30s (#17558). No timer
  // or network wait here, so a generous ceiling costs no fail-fast.
  it('a webhook-less frame admitted on the cache refreshes recency (R3-4)', async (ctx) => {
    // Pin the ceiling: a dropped third argument must fail here, not in CI.
    expect(ctx.task.timeout).toBe(120_000);
    const { adapter, fake } = await connectedAdapter();
    const hook = (session: string): string =>
      `https://oapi.dingtalk.com/robot/sendBySession?session=${session}`;
    for (let i = 0; i < WEBHOOK_LIMIT; i++) {
      expect(
        fake.push(
          `fill-${i}`,
          messageData({
            msgId: `fill-${i}`,
            conversationId: `conv-${i}`,
            sessionWebhook: hook(`w${i}`),
          }),
        ),
      ).toBe(true);
      if ((i + 1) % MANAGED_DINGTALK_PENDING_LIMIT === 0) await adapter.tick();
    }
    // Re-seen conv-0 through webhook-less frames admitted on its cached entry.
    for (let k = 0; k < 3; k++) {
      expect(
        fake.push(
          `revisit-${k}`,
          messageData({
            msgId: `revisit-${k}`,
            conversationId: 'conv-0',
            sessionWebhook: '',
          }),
        ),
      ).toBe(true);
      await adapter.tick();
    }
    expect(
      fake.push(
        'overflow',
        messageData({
          msgId: 'overflow',
          conversationId: 'conv-256',
          sessionWebhook: hook('w256'),
        }),
      ),
    ).toBe(true);
    await adapter.tick();
    const store = (adapter as unknown as { store: { file: string } }).store;
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(Object.hasOwn(persisted.webhooks, 'conv-0')).toBe(true);
    await adapter.disconnect();
  }, 120_000);

  it('a __proto__ conversationId with its own webhook is admitted and cached as an own key (R3-5)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'proto',
      messageData({ msgId: 'proto', conversationId: '__proto__' }),
    );
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:proto',
    ]);
    const store = (adapter as unknown as { store: { file: string } }).store;
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(Object.hasOwn(persisted.webhooks, '__proto__')).toBe(true);
    await adapter.disconnect();
  });

  it('falls back to senderId when senderStaffId is absent (R4)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'fallback',
      messageData({
        msgId: 'fallback',
        senderStaffId: undefined,
        senderId: 'staff-1',
      }),
    );
    await adapter.tick();
    expect(plane.submit.map((event) => event.senderId)).toEqual(['staff-1']);
    await adapter.disconnect();
  });

  it('upgrades a pre-field state file without poisoning instanceRefusals (R2-8)', async () => {
    const cwd = tempCwd();
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
    // A state file written before instanceRefusals existed: the field is absent.
    const store = (
      adapter as unknown as { store: { directory: string; file: string } }
    ).store;
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(
      store.file,
      JSON.stringify({
        version: 1,
        generation: 1,
        pending: [],
        outbound: [],
        recent: [],
        webhooks: {},
      }),
    );
    await adapter.connect();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m1', messageData({ msgId: 'm1' }));
    await adapter.tick();
    // The first refusal increments the absent counter to 1, never NaN.
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(persisted.instanceRefusals).toBe(1);
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
    const text = plane.submit[0]!.text;
    // The notice is reserved inside the char cap, so the marked result still
    // fits the 32,000-unit bound and ends with the notice.
    expect(text.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    expect(text).toBe(
      'x'.repeat(32_000 - CHANNEL_INBOUND_TRUNCATION_NOTICE.length) +
        CHANNEL_INBOUND_TRUNCATION_NOTICE,
    );
    expect(text).toHaveLength(32_000);
    await adapter.disconnect();
  });

  it('clamps a CJK text to the byte envelope even under the character bound', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // The leading ASCII byte makes the reduced byte budget land MID-code-point
    // for the 3-byte CJK char, so the code-point walk must actually reject a
    // partial character instead of landing on an exact boundary (#17173 R2-6).
    fake.push(
      'msg-cjk',
      messageData({
        msgId: 'msg-cjk',
        text: { content: 'a' + '中'.repeat(25_000) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
      64 * 1024 - 4096,
    );
    // The notice's escaped bytes (73) are reserved from the 61,440-byte budget,
    // leaving 61,367 for the core: 'a' + floor((61367-1)/3) = 20,455 CJK chars.
    expect(text.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    expect(text).toBe(
      'a' + '中'.repeat(20_455) + CHANNEL_INBOUND_TRUNCATION_NOTICE,
    );
    await adapter.disconnect();
  });

  it('the byte cut keeps astral code points whole at a mid-pair budget', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // 4-byte astral chars at a budget with a remainder: the exact expected
    // string pins the maximal whole-code-point fit, so an off-by-one in the
    // walk or a miscomputed byte budget reds it (#17173 R2-6).
    fake.push(
      'msg-astral',
      messageData({
        msgId: 'msg-astral',
        text: { content: 'a' + '😀'.repeat(20_000) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    // Core budget 61,367 bytes: 'a' + floor((61367-1)/4) = 15,341 astral chars.
    expect(text.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    expect(text).toBe(
      'a' + '😀'.repeat(15_341) + CHANNEL_INBOUND_TRUNCATION_NOTICE,
    );
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

  it('a replayed admission answer does not reset the refusal streak (R1-26)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m1', messageData({ msgId: 'm1' }));
    fake.push('m2', messageData({ msgId: 'm2' }));
    await adapter.tick();
    // m1 dropped as the first-occurrence sacrifice; m2 held and the stall armed.
    expect(plane.submitAttempts()).toBe(2);
    // The server actually committed m2's admission; only the answer was lost,
    // so the held claim's re-submission answers replayed rather than fresh.
    plane.markAdmitted('dingtalk:m2');
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    // A replay proves nothing about the binding: the streak must stand. The
    // next instance-scoped refusal therefore re-stalls on its FIRST occurrence
    // instead of paying another sacrifice.
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m3', messageData({ msgId: 'm3' }));
    await adapter.tick();
    // The stall re-armed, so a further frame is refused at the gate. Had the
    // replay reset the streak, m3 would have dropped as a fresh sacrifice and
    // this frame would have been admitted.
    expect(fake.push('m4', messageData({ msgId: 'm4' }))).toBe(false);
    await adapter.disconnect();
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

  it('caps the persisted outbound ledger at the shared limit (R1-3)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // Receipt answers are lost so every sent segment stays in the ledger.
    plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    plane.enqueue(
      Array.from({ length: MANAGED_OUTBOUND_LIMIT + 1 }, (_, i) =>
        delivery(`d-${i}`, 1),
      ),
    );
    await adapter.tick();
    expect(fake.sent).toHaveLength(MANAGED_OUTBOUND_LIMIT + 1);
    // The append slices to the cap, so the persisted ledger stays loadable.
    const store = (adapter as unknown as { store: { file: string } }).store;
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(persisted.outbound).toHaveLength(MANAGED_OUTBOUND_LIMIT);
    await adapter.disconnect();
  });

  it('keeps the recent window loadable at the shared cap (R2-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // Drive one past the recent cap; the writer must slice to the same cap the
    // validator enforces, or the persisted state becomes unloadable on restart.
    for (let i = 0; i < RECENT_LIMIT + 1; i++) {
      expect(
        first.fake.push(
          `ev-${i}`,
          messageData({ msgId: `ev-${i}`, conversationId: `conv-${i}` }),
        ),
      ).toBe(true);
      if ((i + 1) % MANAGED_DINGTALK_PENDING_LIMIT === 0)
        await first.adapter.tick();
    }
    await first.adapter.tick();
    const store = (first.adapter as unknown as { store: { file: string } })
      .store;
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(persisted.recent).toHaveLength(RECENT_LIMIT);
    await first.adapter.disconnect();
    // Writer and validator share the cap, so the state still loads.
    const second = await connectedAdapter(cwd);
    await second.adapter.disconnect();
  }, 30_000);

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

  it('evicts the least-recently-seen webhook, not the first-inserted (R1-20)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const hook = (session: string): string =>
      `https://oapi.dingtalk.com/robot/sendBySession?session=${session}`;
    // Fill the webhook map to its cap with distinct conversations, asserting
    // each frame is durably admitted — a refused push would silently shorten
    // the fill. Pace the drain by the claim-table limit, not a literal batch.
    for (let i = 0; i < WEBHOOK_LIMIT; i++) {
      expect(
        fake.push(
          `fill-${i}`,
          messageData({
            msgId: `fill-${i}`,
            conversationId: `conv-${i}`,
            sessionWebhook: hook(`w${i}`),
          }),
        ),
      ).toBe(true);
      if ((i + 1) % MANAGED_DINGTALK_PENDING_LIMIT === 0) await adapter.tick();
    }
    // Re-seen the first-inserted conversation: its recency must refresh.
    fake.push(
      'revisit',
      messageData({
        msgId: 'revisit',
        conversationId: 'conv-0',
        sessionWebhook: hook('w0-new'),
      }),
    );
    await adapter.tick();
    // The 257th conversation overflows the map and evicts the least-recent key.
    fake.push(
      'overflow',
      messageData({
        msgId: 'overflow',
        conversationId: 'conv-256',
        sessionWebhook: hook('w256'),
      }),
    );
    await adapter.tick();
    // The fill must have landed at the cap; a short fill would red here rather
    // than quietly letting the eviction go unexercised.
    const store = (adapter as unknown as { store: { file: string } }).store;
    const persisted = JSON.parse(readFileSync(store.file, 'utf8'));
    expect(Object.keys(persisted.webhooks)).toHaveLength(WEBHOOK_LIMIT);
    // conv-0 was re-seen, so its updated webhook must survive the eviction.
    // The delivery carries no webhook of its own and relies on the cache.
    const probe = delivery('d-0', 1);
    probe.replyContext = {
      conversationId: 'conv-0',
      sessionWebhook: '',
      senderId: 'staff-1',
      robotCode: 'robot-app',
    };
    plane.enqueue([probe]);
    await adapter.tick();
    expect(fake.sent.map((entry) => entry.webhook)).toEqual([hook('w0-new')]);
    await adapter.disconnect();
  }, 30_000);

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

  it('the dropped orphan entry is gone from persisted outbound (R1-14)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    first.plane.enqueue([delivery('d-A', 1), delivery('d-B', 1)]);
    await first.adapter.tick();
    expect(first.fake.sent).toHaveLength(2);
    first.plane.setReceiptError((id) =>
      id === 'd-A'
        ? Object.assign(new Error('gone'), {
            status: 404,
            code: 'delivery_not_found',
          })
        : undefined,
    );
    await first.adapter.tick();
    expect(first.plane.receipts.map((entry) => entry.deliveryId)).toEqual([
      'd-B',
    ]);
    await first.adapter.disconnect();
    // Settling d-B this tick is not enough: the dropped d-A must also be gone
    // from the persisted ledger, or a restart would re-drive it. Neither entry
    // remains, so the restart replays nothing and re-sends nothing.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.receipts).toHaveLength(0);
    expect(second.fake.sent).toHaveLength(0);
    await second.adapter.disconnect();
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

  it('rejects a delivery whose conversationId names a prototype member without sending (R3-1)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const proto = delivery('d-proto', 1);
    proto.replyContext = {
      conversationId: 'constructor',
      sessionWebhook: '',
      senderId: 'staff-1',
      robotCode: 'robot-app',
    };
    plane.enqueue([proto]);
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
    expect(text.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(text), 'utf8')).toBeLessThanOrEqual(
      64 * 1024,
    );
    expect(text.length).toBeLessThan(32_000);
    await adapter.disconnect();
  });

  it('does not admit a lone surrogate at the character-cap boundary (F1)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // 31,001 ASCII + 1,000 emoji: the reduced core char cap lands inside a
    // surrogate pair; the admitted text must stay well-formed and marked.
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
    expect(
      plane.submit[0]!.text.endsWith(CHANNEL_INBOUND_TRUNCATION_NOTICE),
    ).toBe(true);
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

  it('persists the acked inbox backlog when a registration refusal interrupts the drain (R5-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // msgA's admission is refused as not-registered (resets the generation);
    // msgB is already acked into the inbox behind it.
    first.plane.setSubmitErrorFor((id) =>
      id === 'dingtalk:msgA'
        ? Object.assign(new Error('not registered'), {
            status: 404,
            code: 'channel_not_found',
          })
        : undefined,
    );
    first.fake.push(
      'msgA',
      messageData({ msgId: 'msgA', text: { content: 'A' } }),
    );
    first.fake.push(
      'msgB',
      messageData({ msgId: 'msgB', text: { content: 'B' } }),
    );
    await first.adapter.tick();
    // Hard restart: no graceful disconnect. A fresh process reads only the
    // persisted state; an inbox frame left in memory is lost.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual(['A', 'B']);
    await second.adapter.disconnect();
  });

  it('refuses new frames during a re-registration outage so none is acked-and-lost (R5-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // A channel_not_found admission resets the generation.
    first.plane.setSubmitErrorFor((id) =>
      id === 'dingtalk:trigger'
        ? Object.assign(new Error('not registered'), {
            status: 404,
            code: 'channel_not_found',
          })
        : undefined,
    );
    first.fake.push(
      'trigger',
      messageData({ msgId: 'trigger', text: { content: 'trigger' } }),
    );
    await first.adapter.tick();
    // Re-registration now keeps failing (control-plane recovery outage), so
    // ensureRegistered throws before drainInbox on every following tick.
    first.plane.controlPlane.register = async () => {
      throw Object.assign(new Error('HTTP 503'), { status: 503 });
    };
    // Frames arriving during the outage must be left unacked for provider
    // redelivery, not acked into an inbox the drain never reaches.
    expect(
      first.fake.push(
        'n1',
        messageData({ msgId: 'n1', text: { content: 'n1' } }),
      ),
    ).toBe(false);
    expect(
      first.fake.push(
        'n2',
        messageData({ msgId: 'n2', text: { content: 'n2' } }),
      ),
    ).toBe(false);
    expect(
      first.fake.push(
        'n3',
        messageData({ msgId: 'n3', text: { content: 'n3' } }),
      ),
    ).toBe(false);
    await first.adapter.tick().catch(() => {});
    await first.adapter.tick().catch(() => {});
    // Hard restart: the acked trigger survives; the refused frames are the
    // provider's to redeliver, not lost claims.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual(['trigger']);
    await second.adapter.disconnect();
  });

  it('persists a frame acked just before the generation reset when re-registration then fails (R5-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // The outbox claim reports the channel gone (resetting the generation), but
    // a frame is acked into the inbox after this tick's drain already ran — the
    // window between drainInbox and pullOutbox. It is acked while the generation
    // is still live, so the gate admits it; only the next tick's failed
    // re-registration can make it durable.
    first.plane.controlPlane.claimDeliveries = async () => {
      first.fake.push(
        'race',
        messageData({ msgId: 'race', text: { content: 'race' } }),
      );
      throw Object.assign(new Error('channel gone'), {
        status: 404,
        code: 'channel_not_found',
      });
    };
    await first.adapter.tick();
    // Re-registration now keeps failing, so ensureRegistered throws before the
    // drain; the registration-failure path must persist the acked backlog.
    first.plane.controlPlane.register = async () => {
      throw Object.assign(new Error('HTTP 503'), { status: 503 });
    };
    await first.adapter.tick().catch(() => {});
    // Hard restart: the acked frame must survive, not be lost to the outage.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual(['race']);
    await second.adapter.disconnect();
  });

  it('does not claim deliveries when a stop lands mid-tick (R7-1)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d-1', 1), delivery('d-2', 1)]);
    // Park the tick inside submitInbound so a stop can land mid-tick.
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const originalSubmit = plane.controlPlane.submitInbound.bind(
      plane.controlPlane,
    );
    plane.controlPlane.submitInbound = async (event) => {
      await submitGate;
      return originalSubmit(event);
    };
    let claimCalls = 0;
    const originalClaim = plane.controlPlane.claimDeliveries.bind(
      plane.controlPlane,
    );
    plane.controlPlane.claimDeliveries = async (limit) => {
      claimCalls += 1;
      return originalClaim(limit);
    };
    fake.push('m1', messageData({ msgId: 'm1' }));
    const ticking = adapter.tick();
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.disconnect(); // stop while the tick is parked
    releaseSubmit();
    await ticking;
    // The claim itself moves deliveries to sending server-side; a stopped tick
    // must not claim a batch it would abandon to settle unknown.
    expect(claimCalls).toBe(0);
    // The deliveries are still queued, re-claimable on the next start.
    const leftover = await originalClaim(16);
    expect(leftover).toHaveLength(2);
  });

  it('stops persisting after the state lock is compromised (R7-2)', async () => {
    const cwd = tempCwd();
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    let compromise!: () => void;
    const deps: ManagedDingtalkAdapterDeps = {
      ...fake.deps,
      lock: async (_directory, onCompromised) => {
        compromise = onCompromised;
        return async () => {};
      },
    };
    const adapter = new ManagedDingtalkAdapter({
      name: 'ding-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps,
      pollLoop: false,
    });
    await adapter.connect();
    const store = (
      adapter as unknown as { store: { save: (state: unknown) => void } }
    ).store;
    const saveSpy = vi.spyOn(store, 'save');
    // Park the tick inside submitInbound so its post-answer persist lands after
    // the compromise — the in-flight tick, not a shutdown drain, is the writer
    // the ownership guard must silence.
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const originalSubmit = plane.controlPlane.submitInbound.bind(
      plane.controlPlane,
    );
    plane.controlPlane.submitInbound = async (event) => {
      await submitGate;
      return originalSubmit(event);
    };
    fake.push('m1', messageData({ msgId: 'm1' }));
    const ticking = adapter.tick();
    await new Promise((resolve) => setImmediate(resolve));
    saveSpy.mockClear();
    compromise(); // a second owner won the state directory mid-tick
    releaseSubmit();
    await ticking;
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('persists the frame at acceptance so a hard kill before the next tick does not lose it (R8-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.fake.push(
      'm1',
      messageData({ msgId: 'm1', text: { content: 'hello' } }),
    );
    // Hard-kill shape: no tick and no disconnect on the first adapter. A fresh
    // process reads only the persisted state file; an in-memory inbox frame is
    // lost because the provider was already told SUCCESS and never redelivers.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual(['hello']);
    await second.adapter.disconnect();
  });

  it('rejects connect when the lock is compromised during registration (R9-1)', async () => {
    const cwd = tempCwd();
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    let compromise!: () => void;
    let releaseRegister!: () => void;
    const registerGate = new Promise<void>((resolve) => {
      releaseRegister = resolve;
    });
    const originalRegister = plane.controlPlane.register.bind(
      plane.controlPlane,
    );
    plane.controlPlane.register = async (request) => {
      await registerGate;
      return originalRegister(request);
    };
    const deps: ManagedDingtalkAdapterDeps = {
      ...fake.deps,
      lock: async (_directory, onCompromised) => {
        compromise = onCompromised;
        return async () => {};
      },
    };
    const adapter = new ManagedDingtalkAdapter({
      name: 'ding-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps,
      pollLoop: false,
    });
    const connecting = adapter.connect();
    await new Promise((resolve) => setImmediate(resolve));
    compromise(); // lock lost while connect() awaits register
    releaseRegister();
    // The CLI treats a resolved connect() as a healthy start; a compromised
    // adapter must reject so a supervisor can restart it, not park deaf.
    await expect(connecting).rejects.toThrow('stopped during connection');
  });

  it('a frame redelivered while its claim is pending is not staged twice (R10-3)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('m1', messageData({ msgId: 'm1' }));
    // The claim is staged (pending) but not yet submitted — no tick has run.
    const state = (adapter as unknown as { state: { pending: unknown[] } })
      .state;
    expect(state.pending).toHaveLength(1);
    // The provider redelivers the same frame (its admission answer was lost).
    fake.push('m1', messageData({ msgId: 'm1' }));
    expect(state.pending).toHaveLength(1); // not staged a second time
    await adapter.tick();
    expect(plane.submit).toHaveLength(1); // submitted exactly once
    await adapter.disconnect();
  });

  it('a failed claim save leaves no in-memory claim, so redelivery re-stages instead of acking SUCCESS (R11-1)', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // Seed the conversation's webhook and settle the seed claim, so the probe
    // frame below passes the reply-target gate (R1-32) against the cached
    // webhook without committing one of its own.
    first.fake.push('seed', messageData({ msgId: 'seed' }));
    await first.adapter.tick();
    const store = (
      first.adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store;
    // The webhook-less probe frame hits the recency-refresh persist first
    // (claim table empty), then the claim-write persist (claim table non-empty).
    // Fail only the claim write so the rollback under test is actually reached
    // (#17173 R4-1).
    const realSave = store.save.bind(store);
    const saveSpy = vi
      .spyOn(store, 'save')
      .mockImplementation((state: unknown) => {
        if ((state as { pending: unknown[] }).pending.length > 0) {
          throw new Error('disk full');
        }
        realSave(state);
      });
    const frame = messageData({ msgId: 'm1', sessionWebhook: '' });
    // The claim write fails: ack LATER, and no claim may remain in memory.
    expect(first.fake.push('m1', frame)).toBe(false);
    // The rollback must have cleared the in-memory claim table; without it the
    // leftover claim survives the failed save (#17173 R4-1).
    const stateAfterFail = (
      first.adapter as unknown as { state: { pending: unknown[] } }
    ).state;
    expect(stateAfterFail.pending).toHaveLength(0);
    // Redelivery while the save still fails must also be LATER, never SUCCESS.
    expect(first.fake.push('m1', frame)).toBe(false);
    saveSpy.mockRestore();
    // The save succeeds now: the redelivery is staged durably and acked.
    expect(first.fake.push('m1', frame)).toBe(true);
    // A fresh process on the same cwd re-drives the durable claim.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual([
      'hello agent',
    ]);
    await second.adapter.disconnect();
    await first.adapter.disconnect();
  });
});

describe('managed DingTalk webhook cache authority (#17173 round 5)', () => {
  it('a definitively refused webhook is evicted so admission stops trusting it', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.push('seed', messageData({ msgId: 'seed' }));
    await adapter.tick();
    fake.setBehavior('definitive');
    plane.enqueue([delivery('d-evict', 1)]);
    await adapter.tick();
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'rejected',
    );
    // The dead target is gone from the persisted cache the gate trusts, and
    // the eviction itself is visible (R1-1).
    const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
    expect(Object.hasOwn(persisted.webhooks, 'conv-1')).toBe(false);
    expect(
      lines.some(
        (line) =>
          line.includes('evicted the cached webhook') &&
          line.includes('conv-1'),
      ),
    ).toBe(true);
    // A webhook-less frame can no longer be admitted against the dead target;
    // the acked drop is logged once for the burst, never the webhook (R1-1).
    fake.push('after', messageData({ msgId: 'after', sessionWebhook: '' }));
    fake.push('after-2', messageData({ msgId: 'after-2', sessionWebhook: '' }));
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:seed',
    ]);
    const gateDrops = lines.filter(
      (line) =>
        line.includes('no sessionWebhook and none cached') &&
        line.includes('conv-1'),
    );
    expect(gateDrops).toHaveLength(1);
    expect(gateDrops[0]).toContain('after');
    expect(lines.join('\n')).not.toContain('session=abc');
    // A fresh webhook re-commits the conversation.
    fake.push(
      'recommit',
      messageData({
        msgId: 'recommit',
        sessionWebhook:
          'https://oapi.dingtalk.com/robot/sendBySession?session=fresh',
      }),
    );
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:seed',
      'dingtalk:recommit',
    ]);
    await adapter.disconnect();
  });

  it('a transient webhook failure keeps the cached webhook', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('seed', messageData({ msgId: 'seed' }));
    await adapter.tick();
    fake.setBehavior('transient');
    plane.enqueue([delivery('d-keep', 1)]);
    await adapter.tick();
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'unknown',
    );
    const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
    expect(Object.hasOwn(persisted.webhooks, 'conv-1')).toBe(true);
    await adapter.disconnect();
  });

  it('a fresher webhook committed mid-send survives a definitive refusal', async () => {
    const hooks: { beforeSend?: () => void } = {};
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), hooks);
    fake.push('seed', messageData({ msgId: 'seed' }));
    await adapter.tick();
    const fresh = 'https://oapi.dingtalk.com/robot/sendBySession?session=fresh';
    // A new frame commits a fresher webhook while the send is in flight; the
    // refusal below used the OLD webhook, so the fresh entry must stay.
    hooks.beforeSend = () => {
      fake.push('mid', messageData({ msgId: 'mid', sessionWebhook: fresh }));
    };
    fake.setBehavior('definitive');
    plane.enqueue([delivery('d-mid', 1)]);
    await adapter.tick();
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'rejected',
    );
    const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
    expect(persisted.webhooks['conv-1']).toBe(fresh);
    await adapter.disconnect();
  });
});

describe('managed DingTalk admission diagnostics (#17173 R10/R12)', () => {
  it('the no-claim-slot refusal logs once per outage and re-arms on recovery', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    const noSlot = () =>
      lines.filter((line) => line.includes('no durable claim slot'));
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('f1', messageData({ msgId: 'f1' }));
    fake.push('f2', messageData({ msgId: 'f2' }));
    await adapter.tick();
    // f1 paid the first-occurrence drop; f2 is held and the stall engaged.
    expect(fake.push('f3', messageData({ msgId: 'f3' }))).toBe(false);
    expect(fake.push('f4', messageData({ msgId: 'f4' }))).toBe(false);
    expect(noSlot()).toHaveLength(1);
    // The held probe converges and the stall lifts; the next accepted frame
    // re-arms the line for a future outage.
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    expect(fake.push('f3', messageData({ msgId: 'f3' }))).toBe(true);
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('f5', messageData({ msgId: 'f5' }));
    await adapter.tick();
    expect(fake.push('f6', messageData({ msgId: 'f6' }))).toBe(false);
    expect(noSlot()).toHaveLength(2);
    await adapter.disconnect();
  });

  it('a reconnect re-arms the no-claim-slot line', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    const noSlot = () =>
      lines.filter((line) => line.includes('no durable claim slot'));
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('f1', messageData({ msgId: 'f1' }));
    fake.push('f2', messageData({ msgId: 'f2' }));
    await adapter.tick();
    expect(fake.push('f3', messageData({ msgId: 'f3' }))).toBe(false);
    expect(noSlot()).toHaveLength(1);
    await adapter.disconnect();
    await adapter.connect();
    // The persisted held claim re-arms the stall on connect; the outage line
    // must be armed again too, not inherited latched from the last session.
    expect(fake.push('f4', messageData({ msgId: 'f4' }))).toBe(false);
    expect(noSlot()).toHaveLength(2);
    await adapter.disconnect();
  });

  it('a non-text drop leaves a visible log line', async () => {
    const lines: string[] = [];
    const { adapter, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    expect(
      fake.push('pic', messageData({ msgId: 'pic', msgtype: 'picture' })),
    ).toBe(true);
    await adapter.tick();
    // The common trigger — a non-text frame carrying both ids — must be
    // diagnosed as non-text, not as a malformed frame (R1-4).
    const picLine = lines.find((line) => line.includes('pic'));
    expect(picLine).toContain('not a text frame');
    expect(picLine).toContain('picture');
    expect(picLine).not.toContain('conversationId');
    // A genuinely missing field names that field instead.
    expect(
      fake.push(
        'nosender',
        messageData({ msgId: 'nosender', senderStaffId: '', senderId: '' }),
      ),
    ).toBe(true);
    await adapter.tick();
    const noSenderLine = lines.find((line) => line.includes('nosender'));
    expect(noSenderLine).toContain('missing senderId');
    expect(noSenderLine).not.toContain('not a text frame');
    await adapter.disconnect();
  });

  it('a rewritten pollInterval is announced; a valid one is silent', () => {
    const lines: string[] = [];
    const fake = fakeDeps({ log: (line) => lines.push(line) });
    const plane = fakeControlPlane();
    const make = (pollInterval: unknown) =>
      new ManagedDingtalkAdapter({
        name: 'ding-1',
        cwd: tempCwd(),
        config: { ...CONFIG, pollInterval },
        controlPlane: plane.controlPlane,
        deps: fake.deps,
        pollLoop: false,
      });
    const rewritten = make('fast');
    expect(rewritten.settings.pollInterval).toBe(2_000);
    expect(rewritten.settings.pollIntervalRewritten).toBe(true);
    const announced = lines.filter((line) => line.includes('pollInterval'));
    expect(announced).toHaveLength(1);
    // The message must state the bounds the clamp actually enforces: the
    // production line derives them from the shared constants, so moving a
    // bound moves the message and reds this pin (R1-3).
    expect(announced[0]).toContain('[250, 2147483647]');
    lines.length = 0;
    expect(make(500).settings.pollInterval).toBe(500);
    expect(make(500).settings.pollIntervalRewritten).toBe(false);
    expect(make('2000').settings.pollInterval).toBe(2_000);
    expect(make('2000').settings.pollIntervalRewritten).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it('a failed claim save is logged, not silent', async () => {
    const lines: string[] = [];
    const { adapter, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.push('seed', messageData({ msgId: 'seed' }));
    await adapter.tick();
    const store = (
      adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store;
    const realSave = store.save.bind(store);
    let failing = true;
    const saveSpy = vi
      .spyOn(store, 'save')
      .mockImplementation((state: unknown) => {
        if (failing) throw new Error('disk full');
        realSave(state);
      });
    const acceptFailures = () =>
      lines.filter((line) => line.includes('could not durably accept'));
    expect(fake.push('m1', messageData({ msgId: 'm1' }))).toBe(false);
    expect(acceptFailures()).toHaveLength(1);
    expect(acceptFailures()[0]).toContain('m1');
    // A persistent store outage redelivers every frame; the line is latched
    // to one per episode, not one per redelivery (R1-2).
    expect(fake.push('m2', messageData({ msgId: 'm2' }))).toBe(false);
    expect(acceptFailures()).toHaveLength(1);
    // Recovery re-arms the line: an accepted frame clears the latch, so the
    // next outage episode logs again.
    failing = false;
    expect(fake.push('m3', messageData({ msgId: 'm3' }))).toBe(true);
    failing = true;
    expect(fake.push('m4', messageData({ msgId: 'm4' }))).toBe(false);
    expect(acceptFailures()).toHaveLength(2);
    saveSpy.mockRestore();
    await adapter.disconnect();
  });

  it('the outbound ledger entry is durable before the webhook send (R4)', async () => {
    const hooks: { beforeSend?: () => void } = {};
    const { adapter, plane } = await connectedAdapter(tempCwd(), hooks);
    let ledgerAtSend: Array<{ deliveryId: string; ordinal: number }> = [];
    hooks.beforeSend = () => {
      ledgerAtSend = JSON.parse(
        readFileSync(adapter.stateFile, 'utf8'),
      ).outbound;
    };
    plane.enqueue([delivery('d-pre', 1)]);
    await adapter.tick();
    expect(ledgerAtSend).toEqual([
      expect.objectContaining({ deliveryId: 'd-pre', ordinal: 0 }),
    ]);
    await adapter.disconnect();
  });
});

describe('managed DingTalk lifecycle pins (#17173 R2-7/R2-9/R4)', () => {
  it('polls by default when the caller omits pollLoop (R2-7)', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    // The production CLI caller omits pollLoop; the adapter must drive its
    // own tick instead of waiting for a manual one.
    const adapter = new ManagedDingtalkAdapter({
      name: 'ding-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
    });
    await adapter.connect();
    fake.push('auto', messageData({ msgId: 'auto' }));
    await vi.waitFor(
      () => {
        expect(plane.submit.map((event) => event.platformEventId)).toEqual([
          'dingtalk:auto',
        ]);
      },
      { timeout: 5_000 },
    );
    await adapter.disconnect();
  }, 10_000);

  it('stop() aborts the in-flight poll delay so a large interval cannot hang shutdown (R2-9)', async () => {
    vi.useFakeTimers();
    try {
      const plane = fakeControlPlane();
      const fake = fakeDeps();
      const adapter = new ManagedDingtalkAdapter({
        name: 'ding-1',
        cwd: tempCwd(),
        config: { ...CONFIG, pollInterval: 2_147_483_647 },
        controlPlane: plane.controlPlane,
        deps: fake.deps,
      });
      await adapter.connect();
      // Let the loop's first tick finish so it is actually parked in the
      // poll delay; a disconnect that lands before the first tick completes
      // would exit the loop without ever exercising the abort.
      await vi.advanceTimersByTimeAsync(0);
      // The loop is parked in a ~24.8-day delay; without the abort in stop()
      // this disconnect never resolves and the test times out.
      await adapter.disconnect();
      expect(plane.disconnectCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);

  it('disconnect() closes the control plane (R4)', async () => {
    const { adapter, plane } = await connectedAdapter();
    expect(plane.disconnectCalls()).toBe(0);
    await adapter.disconnect();
    expect(plane.disconnectCalls()).toBe(1);
  });
});

describe('managed DingTalk settings pins (#17173 R2-11)', () => {
  it('rejects credentials with whitespace edges or embedded control characters', () => {
    const base = { clientId: 'robot-app', clientSecret: 'secret' };
    expect(() =>
      dingtalkSettings({ ...base, clientId: 'robot-app\n' }),
    ).toThrow(/clientId/);
    expect(() =>
      dingtalkSettings({ ...base, clientSecret: 'sec\rret' }),
    ).toThrow(/clientSecret/);
    expect(() =>
      dingtalkSettings({ ...base, clientSecret: 'sec\0ret' }),
    ).toThrow(/clientSecret/);
    expect(() => dingtalkSettings({ ...base, clientId: '   ' })).toThrow(
      /clientId/,
    );
    expect(() => dingtalkSettings({ ...base, clientSecret: '' })).toThrow(
      /clientSecret/,
    );
    const ok = dingtalkSettings(base);
    expect(ok.clientId).toBe('robot-app');
    expect(ok.clientSecret).toBe('secret');
    // Copy-paste surrounding spaces are trimmed, not rejected.
    expect(
      dingtalkSettings({ ...base, clientId: ' robot-app ' }).clientId,
    ).toBe('robot-app');
  });

  it('refuses privatePolicy pairing instead of silently coercing it', () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    expect(
      () =>
        new ManagedDingtalkAdapter({
          name: 'ding-1',
          cwd: tempCwd(),
          config: { ...CONFIG, privatePolicy: 'pairing' },
          controlPlane: plane.controlPlane,
          deps: fake.deps,
          pollLoop: false,
        }),
    ).toThrow(/pairing/);
  });
});

describe('managed DingTalk persist-failure guards (#17173 R10)', () => {
  type StoreLike = {
    save: (s: unknown) => void;
    directory: string;
  };
  const storeOf = (adapter: ManagedDingtalkAdapter): StoreLike =>
    (adapter as unknown as { store: StoreLike }).store;
  const stateOf = (
    adapter: ManagedDingtalkAdapter,
  ): { pending: unknown[]; outbound: unknown[] } =>
    (
      adapter as unknown as {
        state: { pending: unknown[]; outbound: unknown[] };
      }
    ).state;

  it('a failed settle persist rolls back so the claim re-drives into the replayed answer', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.push('m1', messageData({ msgId: 'm1' }));
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    let failSettle = false;
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      if (failSettle && (state as { pending: unknown[] }).pending.length === 0)
        throw new Error('disk full');
      realSave(state);
    });
    failSettle = true;
    await adapter.tick();
    // The admission answer arrived but the settle write failed: the claim
    // must stay in memory AND on disk, not vanish from this process's
    // re-drive while disk still holds it.
    expect(stateOf(adapter).pending).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(adapter.stateFile, 'utf8')).pending,
    ).toHaveLength(1);
    expect(
      lines.some((line) => line.includes('could not persist the admission')),
    ).toBe(true);
    failSettle = false;
    await adapter.tick();
    // The re-drive meets the idempotent replayed answer and settles.
    expect(plane.submitAttempts()).toBe(2);
    expect(stateOf(adapter).pending).toHaveLength(0);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed ledger persist abandons the send before the side effect', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      if ((state as { outbound: unknown[] }).outbound.length > 0)
        throw new Error('disk full');
      realSave(state);
    });
    plane.enqueue([delivery('d-1', 1)]);
    await adapter.tick();
    // No ledger on disk means no send may happen: the entry is the
    // double-send guard, and the rollback must clear memory too.
    expect(fake.sent).toHaveLength(0);
    expect(stateOf(adapter).outbound).toHaveLength(0);
    expect(
      JSON.parse(readFileSync(adapter.stateFile, 'utf8')).outbound,
    ).toHaveLength(0);
    expect(lines.some((line) => line.includes('outbound ledger'))).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed receipt persist still reports the outcome to the control plane', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      const outbound = (state as { outbound: Array<{ receipt?: unknown }> })
        .outbound;
      if (outbound.some((entry) => entry.receipt)) throw new Error('disk full');
      realSave(state);
    });
    plane.enqueue([delivery('d-1', 1)]);
    await adapter.tick();
    // The send already happened: the server-side settle is the durable
    // record, so the outcome must still be reported.
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(1);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'accepted',
    );
    expect(
      lines.some((line) => line.includes('could not persist the receipt')),
    ).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed hold persist keeps the stall armed in memory', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      const pending = (state as { pending: Array<{ held?: boolean }> }).pending;
      if (pending.some((entry) => entry.held)) throw new Error('disk full');
      realSave(state);
    });
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('f1', messageData({ msgId: 'f1' }));
    fake.push('f2', messageData({ msgId: 'f2' }));
    await adapter.tick();
    // f1 paid the first-occurrence drop; f2's hold write failed but the
    // stall must still gate admission in this process.
    expect(fake.push('f3', messageData({ msgId: 'f3' }))).toBe(false);
    expect(lines.some((line) => line.includes('held claim'))).toBe(true);
    expect(lines.some((line) => line.includes('tick failed'))).toBe(false);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed refusal-drop persist never aborts the tick', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.push('f1', messageData({ msgId: 'f1' }));
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    let failing = false;
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      if (failing) throw new Error('disk full');
      realSave(state);
    });
    plane.setRefuseSubmit({ status: 400 });
    failing = true;
    await adapter.tick();
    expect(stateOf(adapter).pending).toHaveLength(0);
    expect(lines.some((line) => line.includes('refused admission'))).toBe(true);
    expect(lines.some((line) => line.includes('tick failed'))).toBe(false);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed orphan removal persist continues the remaining orphans', async () => {
    const lines: string[] = [];
    const plane = fakeControlPlane();
    const fake = fakeDeps({ log: (line) => lines.push(line) });
    const adapter = new ManagedDingtalkAdapter({
      name: 'ding-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    const store = storeOf(adapter);
    mkdirSync(store.directory, { recursive: true });
    store.save({
      version: 1,
      generation: 1,
      pending: [],
      outbound: [
        { deliveryId: 'o-1', ordinal: 0, messageId: 'm-1' },
        { deliveryId: 'o-2', ordinal: 0, messageId: 'm-2' },
      ],
      recent: [],
      webhooks: {},
    });
    const realSave = store.save.bind(store);
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      if ((state as { outbound: unknown[] }).outbound.length === 1)
        throw new Error('disk full');
      realSave(state);
    });
    await adapter.connect();
    // The first removal write fails; the second orphan must still be
    // reported, not abandoned with the escaped throw.
    expect(plane.receipts.map((receipt) => receipt.deliveryId)).toEqual([
      'o-1',
      'o-2',
    ]);
    expect(lines.some((line) => line.includes('orphan removal'))).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('the settle write that removes a held claim carries the streak reset (R1-2)', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('f1', messageData({ msgId: 'f1' }));
    fake.push('f2', messageData({ msgId: 'f2' }));
    await adapter.tick(); // stall armed, f2 held, streak 2
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    const settleWrites: Array<{ pending: number; refusals?: number }> = [];
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      const s = state as { pending: unknown[]; instanceRefusals?: number };
      if (s.pending.length === 0)
        settleWrites.push({
          pending: s.pending.length,
          refusals: s.instanceRefusals,
        });
      realSave(state);
    });
    plane.setRefuseSubmit(undefined);
    await adapter.tick(); // held probe admitted fresh
    // ONE write removes the claim AND carries the reset streak: a split
    // would let a crash leave disk with pending:[] and the stale streak,
    // so the first transient refusal after a restart would re-hold at once.
    expect(settleWrites).toEqual([{ pending: 0, refusals: 0 }]);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed settle write rolls back the streak and the stall too (R1-2)', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('f1', messageData({ msgId: 'f1' }));
    fake.push('f2', messageData({ msgId: 'f2' }));
    await adapter.tick(); // stall armed, f2 held, streak 2
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    let failedOnce = false;
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      const s = state as { pending: unknown[] };
      if (!failedOnce && s.pending.length === 0) {
        failedOnce = true;
        throw new Error('disk full');
      }
      realSave(state);
    });
    plane.setRefuseSubmit(undefined);
    await adapter.tick(); // the settle write fails
    // Everything the settle touched is rolled back: the claim stays held,
    // the streak stands, and the stall still gates admission.
    const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
    expect(persisted.pending).toHaveLength(1);
    expect(persisted.instanceRefusals).toBe(2);
    expect(stateOf(adapter).pending).toHaveLength(1);
    expect(fake.push('f3', messageData({ msgId: 'f3' }))).toBe(false);
    spy.mockRestore();
    await adapter.tick(); // re-drive converges and lifts the stall
    expect(stateOf(adapter).pending).toHaveLength(0);
    expect(fake.push('f4', messageData({ msgId: 'f4' }))).toBe(true);
    await adapter.disconnect();
  });

  it('the settle-failure line is latched per outage episode (R1-1)', async () => {
    const lines: string[] = [];
    const { adapter, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.push('m1', messageData({ msgId: 'm1' }));
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    let failing = false;
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      const s = state as { pending: unknown[] };
      if (failing && s.pending.length === 0) throw new Error('disk full');
      realSave(state);
    });
    const settleLines = () =>
      lines.filter((line) => line.includes('could not persist the admission'));
    failing = true;
    await adapter.tick();
    await adapter.tick(); // the rollback keeps m1 pending; it re-drives
    expect(settleLines()).toHaveLength(1);
    failing = false;
    await adapter.tick(); // m1 settles; the latch clears
    fake.push('m2', messageData({ msgId: 'm2' }));
    failing = true;
    await adapter.tick(); // a second outage episode logs again
    expect(settleLines()).toHaveLength(2);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed policy-drop persist continues with the remaining claims (R1-4)', async () => {
    const lines: string[] = [];
    const plane = fakeControlPlane();
    const fake = fakeDeps({ log: (line) => lines.push(line) });
    const adapter = new ManagedDingtalkAdapter({
      name: 'ding-1',
      cwd: tempCwd(),
      config: CONFIG, // allowedUsers: ['staff-1']
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    const store = storeOf(adapter);
    mkdirSync(store.directory, { recursive: true });
    const claim = (msgId: string, sender: string) => ({
      eventId: `dingtalk:${msgId}`,
      event: {
        accountGeneration: 1,
        platformEventId: `dingtalk:${msgId}`,
        semanticRevision: 1,
        scope: {
          kind: 'chat_thread',
          senderId: null,
          chatId: 'conv-1',
          threadId: 'conv-1',
        },
        senderId: sender,
        chatId: 'conv-1',
        threadId: 'conv-1',
        subject: null,
        text: 'hello',
        attachments: [],
        replyContext: {
          conversationId: 'conv-1',
          sessionWebhook:
            'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
          senderId: sender,
          robotCode: 'robot-app',
        },
      },
    });
    store.save({
      version: 1,
      generation: 1,
      pending: [claim('revoked', 'intruder'), claim('kept', 'staff-1')],
      outbound: [],
      recent: [],
      webhooks: {
        'conv-1': 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
      },
    });
    const realSave = store.save.bind(store);
    let failedOnce = false;
    await adapter.connect();
    // Install after connect: the policy-drop write is the first write of the
    // tick, and connect's own initial persist must succeed.
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('disk full');
      }
      realSave(state);
    });
    await adapter.tick();
    // The revoked claim drops in memory despite the failed write, and the
    // loop CONTINUES: the second claim still reaches the control plane.
    expect(stateOf(adapter).pending).toHaveLength(0);
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'dingtalk:kept',
    ]);
    expect(lines.some((line) => line.includes('policy drop'))).toBe(true);
    expect(lines.some((line) => line.includes('tick failed'))).toBe(false);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed settled-segment removal persist continues the claimed batch (R1-5)', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    let failedOnce = false;
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      const s = state as { outbound: unknown[] };
      // The first removal write shrinks outbound to empty; fail it once.
      if (!failedOnce && s.outbound.length === 0) {
        failedOnce = true;
        throw new Error('disk full');
      }
      realSave(state);
    });
    plane.enqueue([delivery('d-1', 1), delivery('d-2', 1)]);
    await adapter.tick();
    // Both deliveries send and report; the failed removal must not abandon
    // the second delivery the control plane already moved to sending.
    expect(fake.sent).toHaveLength(2);
    expect(plane.receipts.map((receipt) => receipt.deliveryId)).toEqual([
      'd-1',
      'd-2',
    ]);
    expect(lines.some((line) => line.includes('settled segment'))).toBe(true);
    expect(lines.some((line) => line.includes('tick failed'))).toBe(false);
    spy.mockRestore();
    await adapter.disconnect();
  });
});
