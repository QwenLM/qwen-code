/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MANAGED_OUTBOUND_LIMIT,
  type ManagedChannelControlPlane,
  type ManagedClaimedDelivery,
  type ManagedInboundEvent,
} from '@qwen-code/channel-base';
import {
  ManagedWecomAdapter,
  wecomSettings,
  type ManagedWecomAdapterDeps,
} from './managed-wecom-adapter.js';
import { MANAGED_WECOM_PENDING_LIMIT, RECENT_LIMIT } from './managed-state.js';

// Mirror the DingTalk reference suite, minus the webhook-cache cases (a WeCom
// reply rides the live WebSocket keyed by chatid — no bearer capability to
// cache), plus the WeCom divergences: the provider never redelivers, so a
// failed save loses the frame (logged), and every send failure is unknown
// until a verified errcode table exists.

const CONFIG = {
  type: 'wecom',
  botId: 'bot-1',
  secret: 'secret',
  allowedUsers: ['user-1'],
  dispatchMode: 'followup',
};

function messageData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    msgid: 'msg-1',
    msgtype: 'text',
    chattype: 'single',
    aibotid: 'bot-1',
    from: { userid: 'user-1' },
    text: { content: 'hello agent' },
    ...overrides,
  });
}

function fakeControlPlane(destinationKey = 'cp|tenant-a|chan-1') {
  const register: unknown[] = [];
  const submit: ManagedInboundEvent[] = [];
  const attempts: string[] = [];
  const receipts: Array<{ deliveryId: string; receipt: unknown }> = [];
  const admitted = new Map<string, string>();
  let queue: ManagedClaimedDelivery[] = [];
  let disconnectCalls = 0;
  let submitError: (Error & { status?: number; code?: string }) | undefined;
  let refuseSubmit: { status: number; code?: string } | undefined;
  let submitAttempts = 0;
  let receiptError:
    | ((
        deliveryId: string,
      ) => (Error & { status?: number; code?: string }) | undefined)
    | undefined;
  const controlPlane: ManagedChannelControlPlane = {
    destinationKey,
    register: async (request) => {
      register.push(request);
    },
    disconnect: async () => {
      disconnectCalls += 1;
    },
    submitInbound: async (event) => {
      submitAttempts += 1;
      attempts.push(event.platformEventId);
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
    claimDeliveries: async (limit) => queue.splice(0, limit),
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
    attempts,
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

function fakeDeps(hooks: { log?: (line: string) => void } = {}) {
  let handler: ((messageId: string, data: string) => void) | undefined;
  let stopped: ((reason: string) => void) | undefined;
  const sent: Array<{ chatId: string; text: string }> = [];
  let behavior: 'ok' | 'fail' = 'ok';
  let connected = false;
  const deps: ManagedWecomAdapterDeps = {
    createStreamClient: (_settings, onMessage, onStopped) => {
      handler = onMessage;
      stopped = onStopped;
      return {
        connect: async () => {
          connected = true;
        },
        disconnect: () => {
          connected = false;
        },
      };
    },
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      if (behavior === 'fail') {
        throw new Error('send failed');
      }
    },
    isConnected: () => connected,
    lock: async () => async () => {},
    now: () => 1_750_000_000_000,
    log: hooks.log ?? (() => {}),
  };
  return {
    deps,
    sent,
    push: (messageId: string, data: string) => handler!(messageId, data),
    kick: (reason = 'a new connection displaced this one (server kick)') =>
      stopped!(reason),
    setBehavior: (value: 'ok' | 'fail') => {
      behavior = value;
    },
    setConnected: (value: boolean) => {
      connected = value;
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
      chatId: 'user-1',
      senderId: 'user-1',
      botId: 'bot-1',
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
  const dir = mkdtempSync(join(tmpdir(), 'managed-wecom-'));
  tempDirs.push(dir);
  return dir;
}
// The state store lives under getGlobalQwenDir(), not the workspace cwd; keep
// it inside the sandbox so a run never writes channel state into the real
// global Qwen directory.
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
  hooks: { log?: (line: string) => void } = {},
) {
  const plane = fakeControlPlane();
  const fake = fakeDeps(hooks);
  const adapter = new ManagedWecomAdapter({
    name: 'wecom-1',
    cwd,
    config: CONFIG,
    controlPlane: plane.controlPlane,
    deps: fake.deps,
    pollLoop: false,
  });
  await adapter.connect();
  return { adapter, plane, fake };
}

function pendingOf(adapter: ManagedWecomAdapter): string[] {
  const state = (
    adapter as unknown as { state: { pending: Array<{ eventId: string }> } }
  ).state;
  return state.pending.map((entry) => entry.eventId);
}

describe('managed WeCom adapter inbound', () => {
  it('admits a bot message once and dedupes a redelivery', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('msg-1', messageData());
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.platformEventId).toBe('wecom:msg-1');
    expect(plane.submit[0]!.chatId).toBe('user-1');
    expect(plane.submit[0]!.text).toBe('hello agent');
    expect(plane.submit[0]!.senderId).toBe('user-1');
    // The same platform event pushed again admits nothing new.
    fake.push('msg-1', messageData());
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    await adapter.disconnect();
  });

  it('registers the wecom platform, botId account and resolved policy', async () => {
    const { adapter, plane } = await connectedAdapter();
    expect(plane.register).toHaveLength(1);
    expect(plane.register[0]).toEqual({
      platform: 'wecom',
      accountId: 'bot-1',
      accountGeneration: 1,
      policy: {
        adapter: 'wecom',
        senderPolicy: 'allowlist',
        allowedSenders: ['user-1'],
        dispatchMode: 'followup',
      },
    });
    await adapter.disconnect();
  });

  it(
    'routes a single-chat frame without chatid on the sender userid',
    { timeout: 20_000 },
    async () => {
      const { adapter, plane, fake } = await connectedAdapter();
      // The SDK's send contract addresses a single chat by the user's userid;
      // the frame carries no chatid, so scope, reply context and the send target
      // must all carry the fallback id.
      fake.push('msg-1', messageData());
      await adapter.tick();
      const event = plane.submit[0]!;
      expect(event.chatId).toBe('user-1');
      expect(event.threadId).toBe('user-1');
      expect(event.scope).toEqual({
        kind: 'chat_thread',
        senderId: null,
        chatId: 'user-1',
        threadId: 'user-1',
      });
      expect(event.replyContext).toEqual({
        chatId: 'user-1',
        senderId: 'user-1',
        botId: 'bot-1',
      });
      plane.enqueue([delivery('d1', 1)]);
      await adapter.tick();
      expect(fake.sent).toEqual([{ chatId: 'user-1', text: 'segment 0' }]);
      await adapter.disconnect();
    },
  );

  it('uses an explicit chatid when the frame carries one', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('msg-1', messageData({ chatid: 'chat-explicit' }));
    await adapter.tick();
    expect(plane.submit[0]!.chatId).toBe('chat-explicit');
    expect((plane.submit[0]!.replyContext as { chatId: string }).chatId).toBe(
      'chat-explicit',
    );
    await adapter.disconnect();
  });

  it('drops a group frame under the private-chat policy', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.push(
      'grp',
      messageData({ msgid: 'grp', chattype: 'group', chatid: 'group-1' }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(pendingOf(adapter)).toEqual([]);
    expect(lines.some((line) => line.includes('private chats only'))).toBe(
      true,
    );
    await adapter.disconnect();
  });

  it('skips a non-text message with a msgtype diagnostic', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.push(
      'img',
      messageData({ msgid: 'img', msgtype: 'image', text: undefined }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(
      lines.some((line) =>
        line.includes('is not a text frame (msgtype image)'),
      ),
    ).toBe(true);
    await adapter.disconnect();
  });

  it('skips a frame without a sender userid', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('nouser', messageData({ msgid: 'nouser', from: {} }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('skips a sender outside the allowlist', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'intruder',
      messageData({ msgid: 'intruder', from: { userid: 'intruder' } }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('an open policy admits any sender; disabled admits none', async () => {
    const openPlane = fakeControlPlane();
    const openFake = fakeDeps();
    const open = new ManagedWecomAdapter({
      name: 'wecom-open',
      cwd: tempCwd(),
      config: { ...CONFIG, privatePolicy: 'open' },
      controlPlane: openPlane.controlPlane,
      deps: openFake.deps,
      pollLoop: false,
    });
    await open.connect();
    openFake.push(
      'stranger',
      messageData({ msgid: 'stranger', from: { userid: 'stranger' } }),
    );
    await open.tick();
    expect(openPlane.submit.map((event) => event.senderId)).toEqual([
      'stranger',
    ]);
    await open.disconnect();

    const disabledPlane = fakeControlPlane();
    const disabledFake = fakeDeps();
    const disabled = new ManagedWecomAdapter({
      name: 'wecom-disabled',
      cwd: tempCwd(),
      config: { ...CONFIG, privatePolicy: 'disabled' },
      controlPlane: disabledPlane.controlPlane,
      deps: disabledFake.deps,
      pollLoop: false,
    });
    await disabled.connect();
    disabledFake.push('m1', messageData({ msgid: 'm1' }));
    await disabled.tick();
    expect(disabledPlane.submit).toHaveLength(0);
    await disabled.disconnect();
  });

  it('re-drives a lost admission answer without rebuilding the event', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.failNextSubmit(
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    fake.push('msg-4', messageData({ msgid: 'msg-4' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    // The claim survives; the next tick re-drives the identical event.
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.platformEventId).toBe('wecom:msg-4');
    await adapter.disconnect();
  });

  it('re-drives a persisted admission after a restart, without a stream redelivery', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.failNextSubmit(
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    first.fake.push('msg-9', messageData({ msgid: 'msg-9' }));
    await first.adapter.tick();
    expect(first.plane.submit).toHaveLength(0);
    await first.adapter.disconnect();

    // A fresh process loads the same state. The SDK pushed the message once
    // and the provider never redelivers, so the re-drive must come from the
    // event persisted in the claim — nothing is pushed to this stream.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit).toHaveLength(1);
    expect(second.plane.submit[0]!.platformEventId).toBe('wecom:msg-9');
    expect(second.plane.submit[0]!.text).toBe('hello agent');
    expect(
      (second.plane.submit[0]!.replyContext as { chatId: string }).chatId,
    ).toBe('user-1');
    await second.adapter.disconnect();
  });

  it('persists the frame at acceptance so a hard kill before the next tick does not lose it', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.fake.push('m1', messageData({ msgid: 'm1' }));
    // Hard-kill shape: no tick and no disconnect on the first adapter. A fresh
    // process reads only the persisted state file.
    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual([
      'hello agent',
    ]);
    await second.adapter.disconnect();
  });

  it('truncates an over-long inbound text to the wire bound instead of dropping it', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'msg-long',
      messageData({ msgid: 'msg-long', text: { content: 'x'.repeat(32_001) } }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.text).toHaveLength(32_000);
    await adapter.disconnect();
  });

  it('clamps a CJK text to the byte envelope even under the character bound', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // The leading ASCII byte makes the 61,440-byte budget land MID-code-point
    // for the 3-byte CJK char, so the code-point walk must actually reject a
    // partial character instead of landing on an exact boundary.
    fake.push(
      'msg-cjk',
      messageData({
        msgid: 'msg-cjk',
        text: { content: 'a' + '中'.repeat(25_000) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(
      64 * 1024 - 4096,
    );
    expect(text).toBe('a' + '中'.repeat(20_479));
    await adapter.disconnect();
  });

  it('the byte cut keeps astral code points whole at a mid-pair budget', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'msg-astral',
      messageData({
        msgid: 'msg-astral',
        text: { content: 'a' + '😀'.repeat(20_000) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.text).toBe('a' + '😀'.repeat(15_359));
    await adapter.disconnect();
  });

  it('clamps escape-heavy text by its JSON-serialized length', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // Each control character costs six bytes in the JSON envelope but one
    // UTF-16 unit; the raw length sits far under the byte budget while the
    // serialized length overflows it.
    fake.push(
      'msg-esc',
      messageData({
        msgid: 'msg-esc',
        text: { content: '\u0001'.repeat(20_000) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    expect(text.length).toBeLessThan(20_000);
    expect(
      Buffer.byteLength(JSON.stringify(text), 'utf8') - 2,
    ).toBeLessThanOrEqual(64 * 1024 - 4096);
    // Maximality (lower bound): one more control character would overflow the
    // escaped-byte budget, so the clamp is the largest fitting prefix. An
    // over-truncation by even one code point still satisfies the upper bound
    // above but fails here.
    expect(
      Buffer.byteLength(JSON.stringify(text + String.fromCharCode(1)), 'utf8') -
        2,
    ).toBeGreaterThan(64 * 1024 - 4096);
    await adapter.disconnect();
  });

  it('does not admit a lone surrogate at the character-cap boundary', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // The 32,000th UTF-16 unit is a high surrogate whose pair tail sits past
    // the cap; the clamp must back it off rather than admit a lone surrogate.
    fake.push(
      'msg-surr',
      messageData({
        msgid: 'msg-surr',
        text: { content: 'x'.repeat(31_999) + '😀'.repeat(2) },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    expect(text).toHaveLength(31_999);
    expect(/[\uD800-\uDFFF]/.test(text)).toBe(false);
    await adapter.disconnect();
  });

  it('drops a deterministically refused admission visibly, never re-driving it', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 400 });
    fake.push('msg-poison', messageData({ msgid: 'msg-poison' }));
    await adapter.tick();
    expect(plane.submitAttempts()).toBe(1);
    expect(plane.submit).toHaveLength(0);
    // The claim is gone, so a later tick never re-drives it.
    await adapter.tick();
    expect(plane.submitAttempts()).toBe(1);
    // The rest of the inbound still flows once the refusal clears.
    plane.setRefuseSubmit(undefined);
    fake.push('msg-fine', messageData({ msgid: 'msg-fine' }));
    await adapter.tick();
    expect(plane.submitAttempts()).toBe(2);
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:msg-fine',
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
    fake.push('msg-reg', messageData({ msgid: 'msg-reg' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    const registersBefore = plane.register.length;
    // The claim is kept and the generation reset; the next tick re-registers
    // first, then re-drives the identical event.
    await adapter.tick();
    expect(plane.register.length).toBeGreaterThan(registersBefore);
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:msg-reg',
    ]);
    await adapter.disconnect();
  });

  it('re-registers after a 409 channel_disconnected refusal, keeping the event', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.failNextSubmit(
      Object.assign(new Error('disconnected'), {
        status: 409,
        code: 'channel_disconnected',
      }),
    );
    fake.push('msg-disc', messageData({ msgid: 'msg-disc' }));
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:msg-disc',
    ]);
    await adapter.disconnect();
  });

  it('re-registers after a 409 channel_generation_unregistered refusal, keeping the event', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.failNextSubmit(
      Object.assign(new Error('generation mismatch'), {
        status: 409,
        code: 'channel_generation_unregistered',
      }),
    );
    fake.push('msg-gen', messageData({ msgid: 'msg-gen' }));
    await adapter.tick();
    // A generation mismatch is a registration refusal, not a per-message
    // verdict: the claim is kept and the generation reset, never dropped.
    expect(plane.submit).toHaveLength(0);
    expect(pendingOf(adapter)).toEqual(['wecom:msg-gen']);
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:msg-gen',
    ]);
    await adapter.disconnect();
  });

  it('stalls admission on consecutive workspace_not_found refusals instead of dropping every message', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m1', messageData({ msgid: 'm1', text: { content: 'first' } }));
    fake.push('m2', messageData({ msgid: 'm2', text: { content: 'second' } }));
    fake.push('m3', messageData({ msgid: 'm3', text: { content: 'third' } }));
    await adapter.tick();
    // The first refusal drops as the sacrifice; the second holds and stalls,
    // so the third message is never attempted.
    expect(plane.submitAttempts()).toBe(2);
    expect(plane.submit).toHaveLength(0);
    // During the stall the gate drops new frames — the provider never
    // redelivers, so the loss is the price of the broken binding; the frame
    // must not be staged.
    fake.push('m4', messageData({ msgid: 'm4', text: { content: 'fourth' } }));
    expect(pendingOf(adapter)).not.toContain('wecom:m4');
    await adapter.tick();
    // One held-claim probe per tick; the mail behind the stall stays unattempted.
    expect(plane.submitAttempts()).toBe(3);
    expect(plane.submit).toHaveLength(0);
    // The binding answers again: the held claim and the backlog flow. m3 was
    // persisted as a claim when the stall armed, so this tick lifts the stall
    // and re-drives it from pending; m4 was dropped during the stall and only
    // flows when the user sends it again.
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    fake.push('m4', messageData({ msgid: 'm4', text: { content: 'fourth' } }));
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
      messageData({ msgid: 'm1', text: { content: 'first' } }),
    );
    first.fake.push(
      'm2',
      messageData({ msgid: 'm2', text: { content: 'held' } }),
    );
    await first.adapter.tick();
    expect(first.plane.submitAttempts()).toBe(2);
    await first.adapter.disconnect();

    // The restart re-arms the stall from the persisted held marker. The held
    // re-drive meets a transient 503 (no verdict) while new mail arrives behind
    // the stall — that mail must not be admitted to the still-broken binding.
    const second = await connectedAdapter(cwd);
    second.plane.setRefuseSubmit({ status: 503 });
    second.fake.push(
      'm3',
      messageData({ msgid: 'm3', text: { content: 'behind' } }),
    );
    expect(pendingOf(second.adapter)).not.toContain('wecom:m3');
    await second.adapter.tick();
    expect(second.plane.submitAttempts()).toBe(1);
    expect(second.plane.submit).toHaveLength(0);
    // The binding answers again: this tick lifts the stall and admits the held
    // claim; the mail dropped during the stall flows when sent again.
    second.plane.setRefuseSubmit(undefined);
    await second.adapter.tick();
    second.fake.push(
      'm3',
      messageData({ msgid: 'm3', text: { content: 'behind' } }),
    );
    await second.adapter.tick();
    expect(second.plane.submit.map((event) => event.text)).toEqual([
      'held',
      'behind',
    ]);
    await second.adapter.disconnect();
  });

  it('a replayed admission answer does not reset the refusal streak', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m1', messageData({ msgid: 'm1' }));
    fake.push('m2', messageData({ msgid: 'm2' }));
    await adapter.tick();
    // m1 dropped as the first-occurrence sacrifice; m2 held and the stall armed.
    expect(plane.submitAttempts()).toBe(2);
    // The server actually committed m2's admission; only the answer was lost,
    // so the held claim's re-submission answers replayed rather than fresh.
    plane.markAdmitted('wecom:m2');
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    // A replay proves nothing about the binding: the streak must stand. The
    // next instance-scoped refusal therefore re-stalls on its FIRST occurrence
    // instead of paying another sacrifice.
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m3', messageData({ msgid: 'm3' }));
    await adapter.tick();
    // The stall re-armed, so a further frame is dropped at the gate. Had the
    // replay reset the streak, m3 would have dropped as a fresh sacrifice and
    // this frame would have been staged.
    fake.push('m4', messageData({ msgid: 'm4' }));
    expect(pendingOf(adapter)).not.toContain('wecom:m4');
    await adapter.disconnect();
  });

  it('lifts the stall when the held claim drops on a per-message verdict', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m1', messageData({ msgid: 'm1' }));
    fake.push('m2', messageData({ msgid: 'm2' }));
    await adapter.tick();
    expect(plane.submitAttempts()).toBe(2);
    // The held claim meets a deterministic per-message verdict: it drops, no
    // probe remains, and the stall must lift so later mail flows.
    plane.setRefuseSubmit({ status: 400 });
    await adapter.tick();
    plane.setRefuseSubmit(undefined);
    fake.push('m3', messageData({ msgid: 'm3' }));
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:m3',
    ]);
    await adapter.disconnect();
  });

  it('probes the held claim before an unheld claim that never settles', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // Seed an earlier UNHELD claim and a later HELD claim coexisting, with the
    // stall armed — the shape the held-first sort exists for. Without the
    // sort, the unheld m1 (whose answer never comes) would shadow the one
    // probe per tick and wedge the held claim's admission across ticks.
    fake.push('m1', messageData({ msgid: 'm1' }));
    fake.push('m2', messageData({ msgid: 'm2' }));
    const priv = adapter as unknown as {
      state: {
        pending: Array<{ eventId: string; held?: boolean }>;
        instanceRefusals?: number;
      };
      instanceStalled: boolean;
    };
    priv.state.pending = priv.state.pending.map((entry) =>
      entry.eventId === 'wecom:m2' ? { ...entry, held: true } : entry,
    );
    priv.state.instanceRefusals = 2;
    priv.instanceStalled = true;
    // A transient refusal settles neither claim: the tick must probe exactly
    // the held one, and only it.
    plane.setRefuseSubmit({ status: 503 });
    await adapter.tick();
    expect(plane.attempts.slice(-1)).toEqual(['wecom:m2']);
    expect(plane.submitAttempts()).toBe(1);
    await adapter.disconnect();
  });

  it('drops a persisted claim whose sender the restarted policy revoked', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.failNextSubmit(
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    first.fake.push('m1', messageData({ msgid: 'm1' }));
    await first.adapter.tick();
    await first.adapter.disconnect();

    // The restarted policy no longer allows the sender: the persisted claim
    // drops visibly rather than drive a Session the current policy forbids.
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const second = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: { ...CONFIG, allowedUsers: [] },
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await second.connect();
    await second.tick();
    expect(plane.submit).toHaveLength(0);
    expect(pendingOf(second)).toEqual([]);
    await second.disconnect();
  });

  it('a frame redelivered while its claim is pending is not staged twice', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push('m1', messageData({ msgid: 'm1' }));
    // The claim is staged (pending) but not yet submitted — no tick has run.
    expect(pendingOf(adapter)).toEqual(['wecom:m1']);
    // The SDK pushes the same frame again (its admission answer was lost).
    fake.push('m1', messageData({ msgid: 'm1' }));
    expect(pendingOf(adapter)).toEqual(['wecom:m1']); // not staged twice
    await adapter.tick();
    expect(plane.submit).toHaveLength(1); // submitted exactly once
    await adapter.disconnect();
  });

  it('a failed claim save loses exactly one frame, logs the loss, and leaves no in-memory claim', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    const store = (
      adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store;
    const realSave = store.save.bind(store);
    const saveSpy = vi
      .spyOn(store, 'save')
      .mockImplementation((state: unknown) => {
        if ((state as { pending: unknown[] }).pending.length > 0) {
          throw new Error('disk full');
        }
        realSave(state);
      });
    // The claim write fails: the provider never redelivers, so the frame is
    // lost — but no claim may remain in memory, and the loss must be logged.
    fake.push('m1', messageData({ msgid: 'm1' }));
    expect(pendingOf(adapter)).toEqual([]);
    expect(
      lines.some(
        (line) =>
          line.includes('could not durably accept message m1') &&
          line.includes('does not redeliver'),
      ),
    ).toBe(true);
    // A second push while the save still fails is also lost, never staged.
    fake.push('m1', messageData({ msgid: 'm1' }));
    expect(pendingOf(adapter)).toEqual([]);
    saveSpy.mockRestore();
    // The save succeeds now: a later copy of the frame is staged durably —
    // the failed save must not have poisoned the dedupe window.
    fake.push('m1', messageData({ msgid: 'm1' }));
    expect(pendingOf(adapter)).toEqual(['wecom:m1']);
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:m1',
    ]);
    await adapter.disconnect();
  });

  it('the no-claim-slot drop logs once per outage and re-arms on recovery', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    // Fill the claim table without settling anything.
    for (let i = 0; i < MANAGED_WECOM_PENDING_LIMIT; i += 1) {
      fake.push(`m${i}`, messageData({ msgid: `m${i}` }));
    }
    expect(pendingOf(adapter)).toHaveLength(MANAGED_WECOM_PENDING_LIMIT);
    fake.push('over', messageData({ msgid: 'over' }));
    fake.push('over2', messageData({ msgid: 'over2' }));
    const slotLines = lines.filter((line) =>
      line.includes('no durable claim slot'),
    );
    expect(slotLines).toHaveLength(1);
    expect(slotLines[0]).toContain('does not redeliver');
    // Recovery: one admission frees a slot and re-arms the line.
    await adapter.tick();
    fake.push('over', messageData({ msgid: 'over' }));
    expect(pendingOf(adapter)).toContain('wecom:over');
    await adapter.disconnect();
    expect(plane.submit.length).toBeGreaterThan(0);
  });

  it('refuses new frames during a re-registration outage so none is staged-and-lost', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.failNextSubmit(
      Object.assign(new Error('not registered'), {
        status: 404,
        code: 'channel_not_found',
      }),
    );
    fake.push('m1', messageData({ msgid: 'm1' }));
    await adapter.tick();
    // The generation reset gates new frames until re-registration succeeds.
    fake.push('m2', messageData({ msgid: 'm2' }));
    expect(pendingOf(adapter)).toEqual(['wecom:m1']);
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:m1',
    ]);
    // Re-registration done: new frames flow again.
    fake.push('m3', messageData({ msgid: 'm3' }));
    await adapter.tick();
    expect(plane.submit.map((event) => event.platformEventId)).toEqual([
      'wecom:m1',
      'wecom:m3',
    ]);
    await adapter.disconnect();
  });

  it('a kick stops the adapter', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (line) => lines.push(line),
    });
    fake.kick();
    expect(lines.some((line) => line.includes('adapter stopped'))).toBe(true);
    // A stopped adapter stages nothing and claims nothing.
    fake.push('m1', messageData({ msgid: 'm1' }));
    plane.enqueue([delivery('d1', 1)]);
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(fake.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  it('rejects connect when the lock is compromised during registration', async () => {
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
    const deps: ManagedWecomAdapterDeps = {
      ...fake.deps,
      lock: async (_directory, onCompromised) => {
        compromise = onCompromised;
        return async () => {};
      },
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
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

  it('stops persisting after the state lock is compromised', async () => {
    const cwd = tempCwd();
    let compromise!: () => void;
    let releaseSubmit!: () => void;
    const submitGate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    const plane = fakeControlPlane();
    const originalSubmit = plane.controlPlane.submitInbound.bind(
      plane.controlPlane,
    );
    plane.controlPlane.submitInbound = async (event) => {
      await submitGate;
      return originalSubmit(event);
    };
    const fake = fakeDeps();
    const deps: ManagedWecomAdapterDeps = {
      ...fake.deps,
      lock: async (_directory, onCompromised) => {
        compromise = onCompromised;
        return async () => {};
      },
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps,
      pollLoop: false,
    });
    await adapter.connect();
    // Stage a claim, then start a tick that parks inside submit's await.
    fake.push('m1', messageData({ msgid: 'm1' }));
    const stateFile = adapter.stateFile;
    const before = readFileSync(stateFile, 'utf8');
    const ticking = adapter.tick();
    await new Promise((resolve) => setImmediate(resolve));
    // The lock is lost WHILE the tick is in flight; the post-await persist on
    // submit's success path must not rewrite the file the new owner holds.
    compromise();
    releaseSubmit();
    await ticking.catch(() => {});
    expect(readFileSync(stateFile, 'utf8')).toBe(before);
  });
});

describe('managed WeCom adapter outbox', () => {
  it('sends each segment in order and receipts each by ordinal', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d1', 3)]);
    await adapter.tick();
    expect(fake.sent).toEqual([
      { chatId: 'user-1', text: 'segment 0' },
      { chatId: 'user-1', text: 'segment 1' },
      { chatId: 'user-1', text: 'segment 2' },
    ]);
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd1',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: expect.any(String),
          acceptedAt: 1_750_000_000_000,
        },
      },
      {
        deliveryId: 'd1',
        receipt: {
          outcome: 'accepted',
          ordinal: 1,
          providerMessageId: expect.any(String),
          acceptedAt: 1_750_000_000_000,
        },
      },
      {
        deliveryId: 'd1',
        receipt: {
          outcome: 'accepted',
          ordinal: 2,
          providerMessageId: expect.any(String),
          acceptedAt: 1_750_000_000_000,
        },
      },
    ]);
    await adapter.disconnect();
  });

  it('reports a send failure as unknown and never resends', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.setBehavior('fail');
    plane.enqueue([delivery('d1', 2)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1); // the failing segment only
    expect(plane.receipts).toEqual([
      { deliveryId: 'd1', receipt: { outcome: 'unknown' } },
    ]);
    // The next tick re-drives the receipt, never the send; the remaining
    // segment waits behind the settled one.
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    await adapter.disconnect();
  });

  it('rejects a delivery whose committed chatId is missing, without sending', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const broken = delivery('d1', 1);
    broken.replyContext = { senderId: 'user-1', botId: 'bot-1' };
    plane.enqueue([broken, delivery('d2', 1)]);
    await adapter.tick();
    expect(fake.sent).toEqual([{ chatId: 'user-1', text: 'segment 0' }]);
    expect(plane.receipts).toEqual([
      { deliveryId: 'd1', receipt: { outcome: 'rejected' } },
      {
        deliveryId: 'd2',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: expect.any(String),
          acceptedAt: 1_750_000_000_000,
        },
      },
    ]);
    await adapter.disconnect();
  });

  it('refuses a reply whose sender the policy does not allow without sending', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const intruder = delivery('d1', 1);
    intruder.replyContext = {
      chatId: 'intruder',
      senderId: 'intruder',
      botId: 'bot-1',
    };
    plane.enqueue([intruder]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(0);
    expect(plane.receipts).toEqual([
      { deliveryId: 'd1', receipt: { outcome: 'rejected' } },
    ]);
    await adapter.disconnect();
  });

  it('a refused rejection receipt does not abort the claimed batch', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.setReceiptError((deliveryId) =>
      deliveryId === 'd1'
        ? Object.assign(new Error('receipt lost'), { status: 503 })
        : undefined,
    );
    const broken = delivery('d1', 1);
    broken.replyContext = { senderId: 'user-1', botId: 'bot-1' };
    plane.enqueue([broken, delivery('d2', 1)]);
    await adapter.tick();
    // d1's rejection could not be reported; d2 still sends.
    expect(fake.sent).toEqual([{ chatId: 'user-1', text: 'segment 0' }]);
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual(['d2']);
    await adapter.disconnect();
  });

  it('stops the rest of a multi-segment delivery after a non-accepted segment', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.setBehavior('fail');
    plane.enqueue([delivery('d1', 3)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toEqual([
      { deliveryId: 'd1', receipt: { outcome: 'unknown' } },
    ]);
    await adapter.disconnect();
  });

  it('replays the persisted provider receipt on restart instead of settling unknown', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // The send succeeds but the receipt answer is lost: the entry stays
    // outbound with the accepted receipt persisted.
    first.plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    first.plane.enqueue([delivery('d1', 1)]);
    await first.adapter.tick();
    expect(first.fake.sent).toHaveLength(1);
    await first.adapter.disconnect();

    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    // The restart replays the persisted accepted receipt — never a second
    // send, never an unknown downgrade.
    expect(second.fake.sent).toHaveLength(0);
    expect(second.plane.receipts).toEqual([
      {
        deliveryId: 'd1',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: expect.any(String),
          acceptedAt: 1_750_000_000_000,
        },
      },
    ]);
    await second.adapter.disconnect();
  });

  it('settles an outcome-less outbound entry unknown on restart', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // Hard-kill shape: the outbound entry is persisted before the send, and
    // the process dies before any outcome exists.
    const state = (
      first.adapter as unknown as {
        state: { outbound: unknown[] };
        store: { save: (s: unknown) => void };
      }
    ).state;
    state.outbound = [
      { deliveryId: 'd-orphan', ordinal: 0, messageId: 'm-orphan' },
    ];
    (
      first.adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store.save(state);
    await first.adapter.disconnect();

    const second = await connectedAdapter(cwd);
    await second.adapter.tick();
    expect(second.fake.sent).toHaveLength(0);
    expect(second.plane.receipts).toEqual([
      { deliveryId: 'd-orphan', receipt: { outcome: 'unknown' } },
    ]);
    await second.adapter.disconnect();
  });

  it('drops a deterministically refused orphan receipt without wedging later ones', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    const state = (
      first.adapter as unknown as {
        state: { outbound: unknown[] };
        store: { save: (s: unknown) => void };
      }
    ).state;
    state.outbound = [
      { deliveryId: 'd-poison', ordinal: 0, messageId: 'm-poison' },
      { deliveryId: 'd-fine', ordinal: 0, messageId: 'm-fine' },
    ];
    (
      first.adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store.save(state);
    await first.adapter.disconnect();

    // Arm the refusal BEFORE connect: connect() itself drains orphaned
    // outbound, so the poison verdict must already be in place.
    const plane = fakeControlPlane();
    plane.setReceiptError((deliveryId) =>
      deliveryId === 'd-poison'
        ? Object.assign(new Error('gone'), {
            status: 404,
            code: 'delivery_not_found',
          })
        : undefined,
    );
    const fake = fakeDeps();
    const second = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await second.connect();
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual(['d-fine']);
    // The dropped entry is gone from persisted outbound.
    const persisted = JSON.parse(readFileSync(second.stateFile, 'utf8'));
    expect(persisted.outbound).toEqual([]);
    await second.disconnect();
  });

  it('re-registers after an orphan receipt is refused as not registered', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // Create the orphan live: the send succeeds but the receipt answer is
    // lost, so the entry stays outbound with no reported receipt.
    plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    plane.enqueue([delivery('d-orphan', 1)]);
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
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual([
      'd-orphan',
    ]);
    await adapter.disconnect();
  });

  it('an orphan receipt met by a transient refusal keeps the entry and replays it accepted', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // Tick 1: the send succeeds but the receipt answer is lost, leaving an
    // orphan entry with a persisted ACCEPTED receipt.
    plane.setReceiptError(() =>
      Object.assign(new Error('answer lost'), { status: 503 }),
    );
    plane.enqueue([delivery('d1', 1)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toEqual([]);
    // Tick 2: the orphan replay meets a transient refusal too. The transient
    // arm CONTAINS it (keep the entry, log, proceed) — it must not fall through
    // to the deterministic drop (a dropped accepted receipt would settle a
    // delivered reply unknown) and must not abort the tick before the outbox is
    // pulled. So the tick resolves and the outbox poll still runs.
    let claims = 0;
    const origClaim = plane.controlPlane.claimDeliveries.bind(
      plane.controlPlane,
    );
    plane.controlPlane.claimDeliveries = async (limit) => {
      claims += 1;
      return origClaim(limit);
    };
    await adapter.tick();
    expect(claims).toBe(1);
    const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
    expect(persisted.outbound).toHaveLength(1);
    expect(persisted.outbound[0].receipt.outcome).toBe('accepted');
    // Tick 3: the refusal clears; the accepted receipt replays verbatim,
    // never a second send and never an unknown downgrade.
    plane.setReceiptError(undefined);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toEqual([
      {
        deliveryId: 'd1',
        receipt: expect.objectContaining({ outcome: 'accepted', ordinal: 0 }),
      },
    ]);
    await adapter.disconnect();
  });

  it('re-registers after a claim is refused as not registered', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    const originalClaim = plane.controlPlane.claimDeliveries.bind(
      plane.controlPlane,
    );
    let once = true;
    plane.controlPlane.claimDeliveries = async (limit) => {
      if (once) {
        once = false;
        throw Object.assign(new Error('not registered'), {
          status: 404,
          code: 'channel_not_found',
        });
      }
      return originalClaim(limit);
    };
    plane.enqueue([delivery('d1', 1)]);
    // The claim refusal resets the generation instead of escaping the tick;
    // nothing is claimed-and-abandoned.
    await adapter.tick();
    expect(fake.sent).toHaveLength(0);
    const registersBefore = plane.register.length;
    await adapter.tick();
    expect(plane.register.length).toBeGreaterThan(registersBefore);
    expect(fake.sent).toHaveLength(1);
    await adapter.disconnect();
  });

  it('the outbound ledger entry is durable before the send', async () => {
    let durableAtSend: unknown;
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: {
        ...fake.deps,
        sendMessage: async (chatId, text) => {
          // Read the adapter's own state file at send time: the ledger entry
          // must already be on disk before the side effect.
          durableAtSend = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
          return fake.deps.sendMessage(chatId, text);
        },
      },
      pollLoop: false,
    });
    await adapter.connect();
    plane.enqueue([delivery('d1', 1)]);
    await adapter.tick();
    expect(
      (durableAtSend as { outbound: Array<{ deliveryId: string }> }).outbound,
    ).toEqual([expect.objectContaining({ deliveryId: 'd1', ordinal: 0 })]);
    await adapter.disconnect();
  });
});

describe('managed WeCom adapter lifecycle pins', () => {
  it('polls by default when the caller omits pollLoop', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: { ...CONFIG, pollInterval: 250 },
      controlPlane: plane.controlPlane,
      deps: fake.deps,
    });
    await adapter.connect();
    fake.push('m1', messageData({ msgid: 'm1' }));
    // No manual tick: the default poll loop must admit the frame on its own.
    await vi.waitFor(() => expect(plane.submit).toHaveLength(1));
    await adapter.disconnect();
  });

  it('stop() aborts the in-flight poll delay so a large interval cannot hang shutdown', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: { ...CONFIG, pollInterval: 2_147_483_647 },
      controlPlane: plane.controlPlane,
      deps: fake.deps,
    });
    await adapter.connect();
    // Let the first tick finish and the loop enter the (maximum-interval)
    // delay, so disconnect must abort an in-flight sleep — not just exit via
    // the running guard before the delay is reached. Without the abort signal
    // this disconnect would hang ~24.8 days and the test times out.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    await adapter.disconnect();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('disconnect() closes the control plane', async () => {
    const { adapter, plane } = await connectedAdapter();
    await adapter.disconnect();
    expect(plane.disconnectCalls()).toBe(1);
  });
});

describe('managed WeCom settings pins', () => {
  it('rejects credentials with whitespace edges or embedded control characters', () => {
    expect(() => wecomSettings({ botId: 'bot', secret: 'ok' })).not.toThrow();
    for (const bad of ['bot\n', 'bot\rx', 'bot\0', '   ', 7]) {
      expect(() => wecomSettings({ botId: bad, secret: 'ok' })).toThrow(
        /botId/,
      );
      expect(() => wecomSettings({ botId: 'bot', secret: bad })).toThrow(
        /secret/,
      );
    }
    // Copy-paste surrounding spaces are trimmed, not rejected.
    expect(wecomSettings({ botId: ' bot ', secret: 'ok' }).botId).toBe('bot');
  });

  it('requires wsUrl to use wss:// when present', () => {
    expect(
      wecomSettings({
        botId: 'bot',
        secret: 'ok',
        wsUrl: 'wss://openws.work.weixin.qq.com',
      }).wsUrl,
    ).toBe('wss://openws.work.weixin.qq.com');
    expect(() =>
      wecomSettings({ botId: 'bot', secret: 'ok', wsUrl: 'ws://insecure' }),
    ).toThrow(/wss/);
    expect(() =>
      wecomSettings({ botId: 'bot', secret: 'ok', wsUrl: 'not a url' }),
    ).toThrow(/wss/);
    expect(wecomSettings({ botId: 'bot', secret: 'ok' }).wsUrl).toBeUndefined();
  });

  it('refuses privatePolicy pairing instead of silently coercing it', () => {
    expect(
      () =>
        new ManagedWecomAdapter({
          name: 'wecom-1',
          cwd: tempCwd(),
          config: { ...CONFIG, privatePolicy: 'pairing' },
          controlPlane: fakeControlPlane().controlPlane,
          deps: fakeDeps().deps,
          pollLoop: false,
        }),
    ).toThrow(/pairing/);
  });

  it('a rewritten pollInterval is announced; a valid one is silent', () => {
    const lines: string[] = [];
    const build = (pollInterval: unknown) =>
      new ManagedWecomAdapter({
        name: 'wecom-1',
        cwd: tempCwd(),
        config: { ...CONFIG, pollInterval },
        controlPlane: fakeControlPlane().controlPlane,
        deps: fakeDeps({ log: (line) => lines.push(line) }).deps,
        pollLoop: false,
      });
    build(100);
    expect(lines.some((line) => line.includes('pollInterval'))).toBe(true);
    expect(lines[0]).toContain('[250, 2147483647]');
    lines.length = 0;
    build(1_000);
    expect(lines).toEqual([]);
    // null is nullish and coalesces to the default silently (DingTalk parity).
    expect(
      wecomSettings({ ...CONFIG, pollInterval: null }).pollIntervalRewritten,
    ).toBe(false);
  });

  it('rejects a non-string or empty-host wsUrl', () => {
    expect(() => wecomSettings({ ...CONFIG, wsUrl: 42 })).toThrow(/wss/);
    expect(() => wecomSettings({ ...CONFIG, wsUrl: 'wss://' })).toThrow(/wss/);
  });
});

describe('managed WeCom adapter hostile inputs', () => {
  it('survives non-object JSON bodies without throwing or admitting', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    for (const body of ['[]', 'null', '"str"', '42', '{"from":"x","text":5}']) {
      expect(() => fake.push('m', body)).not.toThrow();
    }
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('drops a non-text frame even when text.content is present', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'img',
      messageData({
        msgid: 'img',
        msgtype: 'image',
        text: { content: 'sneaky' },
      }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    await adapter.disconnect();
  });

  it('treats prototype-member ids as plain strings end to end', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: { ...CONFIG, privatePolicy: 'open' },
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await adapter.connect();
    fake.push(
      'm',
      messageData({ chatid: '__proto__', from: { userid: 'constructor' } }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    expect(plane.submit[0]!.chatId).toBe('__proto__');
    expect(plane.submit[0]!.senderId).toBe('constructor');
    const d = delivery('d1', 1);
    d.replyContext = {
      chatId: '__proto__',
      senderId: 'constructor',
      botId: 'bot-1',
    };
    plane.enqueue([d]);
    await adapter.tick();
    // The send path addresses the literal string, never an inherited value.
    expect(fake.sent).toEqual([{ chatId: '__proto__', text: 'segment 0' }]);
    await adapter.disconnect();
  });

  it('admits a lone low surrogate mid-text as well-formed JSON', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    fake.push(
      'surr',
      messageData({ msgid: 'surr', text: { content: 'a\uD800b' } }),
    );
    await adapter.tick();
    expect(plane.submit).toHaveLength(1);
    const text = plane.submit[0]!.text;
    expect(JSON.parse(JSON.stringify(text))).toEqual(text);
    await adapter.disconnect();
  });

  it('a kick mid-send stops the remaining segments', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: {
        ...fake.deps,
        sendMessage: async (chatId, text) => {
          await gate;
          return fake.deps.sendMessage(chatId, text);
        },
      },
      pollLoop: false,
    });
    await adapter.connect();
    plane.enqueue([delivery('d1', 2)]);
    const ticking = adapter.tick();
    await new Promise((resolve) => setImmediate(resolve));
    fake.kick();
    release();
    await ticking;
    // Segment 0 was in flight when the kick landed; segment 1 must not send.
    expect(fake.sent.length).toBeLessThanOrEqual(1);
    await adapter.disconnect();
  });

  it('a lock compromise mid-send never rewrites the state file', async () => {
    let release!: () => void;
    let compromise!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: {
        ...fake.deps,
        sendMessage: async (chatId, text) => {
          await gate;
          return fake.deps.sendMessage(chatId, text);
        },
        lock: async (_directory, onCompromised) => {
          compromise = onCompromised;
          return async () => {};
        },
      },
      pollLoop: false,
    });
    await adapter.connect();
    plane.enqueue([delivery('d1', 1)]);
    const ticking = adapter.tick();
    await new Promise((resolve) => setImmediate(resolve));
    // The pre-send persist legitimately ran while ownership was held;
    // snapshot here, then lose the lock mid-send.
    const before = readFileSync(adapter.stateFile, 'utf8');
    expect(before).toContain('"outbound":[{"deliveryId":"d1"');
    compromise();
    release();
    await ticking;
    // The post-send receipt persist is suppressed: bytes unchanged, entry
    // still carries no receipt.
    expect(readFileSync(adapter.stateFile, 'utf8')).toBe(before);
  });

  it('refuses an over-cap state file at connect', async () => {
    const cwd = tempCwd();
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(adapter.stateFile), { recursive: true });
    writeFileSync(
      adapter.stateFile,
      JSON.stringify({
        version: 1,
        generation: 1,
        pending: [],
        outbound: Array.from(
          { length: MANAGED_OUTBOUND_LIMIT + 1 },
          (_, i) => ({
            deliveryId: `d${i}`,
            ordinal: 0,
            messageId: `m${i}`,
          }),
        ),
        recent: [],
      }),
    );
    await expect(adapter.connect()).rejects.toThrow(/is invalid/);
  });
});

describe('managed WeCom adapter review fixes (round 2)', () => {
  it('treats a blank or null wsUrl as absent, still refuses a non-string', () => {
    expect(wecomSettings({ ...CONFIG, wsUrl: null }).wsUrl).toBeUndefined();
    expect(wecomSettings({ ...CONFIG, wsUrl: '' }).wsUrl).toBeUndefined();
    expect(wecomSettings({ ...CONFIG, wsUrl: '   ' }).wsUrl).toBeUndefined();
    expect(() => wecomSettings({ ...CONFIG, wsUrl: 42 })).toThrow(/wss/);
    expect(() => wecomSettings({ ...CONFIG, wsUrl: 'http://x' })).toThrow(
      /wss/,
    );
  });

  it('connect rejects with the ownership sentence when the lock refuses, writing no state', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: {
        ...fake.deps,
        lock: async () => {
          throw new Error('ELOCKED');
        },
      },
      pollLoop: false,
    });
    await expect(adapter.connect()).rejects.toThrow(/owned by another process/);
    expect(plane.register).toHaveLength(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(adapter.stateFile)).toBe(false);
  });

  it('a second connect on one adapter rejects as already connected', async () => {
    const { adapter } = await connectedAdapter();
    await expect(adapter.connect()).rejects.toThrow(/already connected/);
    await adapter.disconnect();
  });

  it('a transient orphan-receipt refusal at connect does not keep the channel from starting', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    // Leave an outcome-less orphan entry persisted (hard-kill shape).
    const priv = first.adapter as unknown as {
      state: { outbound: unknown[] };
      store: { save: (s: unknown) => void };
    };
    priv.state.outbound = [
      { deliveryId: 'd-orphan', ordinal: 0, messageId: 'm-orphan' },
    ];
    priv.store.save(priv.state);
    await first.adapter.disconnect();

    const plane = fakeControlPlane();
    plane.setReceiptError(() =>
      Object.assign(new Error('service unavailable'), { status: 503 }),
    );
    const fake = fakeDeps();
    const lines: string[] = [];
    const second = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: { ...fake.deps, log: (l) => lines.push(l) },
      pollLoop: false,
    });
    // connect resolves despite the transient orphan refusal; the entry stays
    // and the containment is logged (the replay re-drives on the next tick).
    await second.connect();
    expect(
      lines.some((l) =>
        l.includes('receipt for d-orphan could not be reported'),
      ),
    ).toBe(true);
    const persisted = JSON.parse(readFileSync(second.stateFile, 'utf8'));
    expect(persisted.outbound).toHaveLength(1);
    await second.disconnect();
  });

  it('a null JSON body is dropped as malformed and does not poison the loss latch', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    fake.push('nullmsg', 'null');
    await adapter.tick();
    expect(plane.submit).toHaveLength(0);
    expect(lines.some((l) => l.includes('is not a JSON object'))).toBe(true);
    expect(lines.some((l) => l.includes('could not durably accept'))).toBe(
      false,
    );
    // A genuine save failure on the NEXT frame must still log (latch unpoisoned).
    const store = (
      adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store;
    const realSave = store.save.bind(store);
    const spy = vi.spyOn(store, 'save').mockImplementation((s: unknown) => {
      if ((s as { pending: unknown[] }).pending.length > 0)
        throw new Error('disk full');
      realSave(s);
    });
    fake.push('m1', messageData({ msgid: 'm1' }));
    expect(
      lines.some((l) => l.includes('could not durably accept message m1')),
    ).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a store failure on the settle path is logged and rethrown, not swallowed', async () => {
    const lines: string[] = [];
    const { adapter, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    fake.push('m1', messageData({ msgid: 'm1' }));
    const store = (
      adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store;
    const realSave = store.save.bind(store);
    // Let staging persist, then fail the settle-path save (pending emptied).
    const spy = vi.spyOn(store, 'save').mockImplementation((s: unknown) => {
      if (
        (s as { pending: unknown[] }).pending.length === 0 &&
        (s as { recent: string[] }).recent.includes('wecom:m1')
      ) {
        throw new Error('disk full');
      }
      realSave(s);
    });
    await expect(adapter.tick()).rejects.toThrow('disk full');
    expect(
      lines.some((l) => l.includes('could not persist settled claim wecom:m1')),
    ).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a persistent registration failure logs one latched line, re-arming on recovery', async () => {
    const lines: string[] = [];
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    let failRegister = true;
    const origRegister = plane.controlPlane.register.bind(plane.controlPlane);
    plane.controlPlane.register = async (req) => {
      if (failRegister)
        throw Object.assign(new Error('channel row deleted'), {
          status: 404,
          code: 'channel_not_found',
        });
      return origRegister(req);
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: { ...CONFIG, pollInterval: 250 },
      controlPlane: plane.controlPlane,
      deps: { ...fake.deps, log: (l) => lines.push(l) },
      pollLoop: true,
    });
    // connect's own ensureRegistered throws → connect rejects; drive via tick
    // instead by connecting against a registering plane then breaking it.
    failRegister = false;
    await adapter.connect();
    failRegister = true;
    // Force re-registration each tick by resetting the registered generation.
    (
      adapter as unknown as { registeredGeneration: number }
    ).registeredGeneration = 0;
    await vi.waitFor(() => {
      expect(
        lines.filter((l) => l.includes('registration is failing')).length,
      ).toBeGreaterThanOrEqual(1);
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(
      lines.filter((l) => l.includes('registration is failing')),
    ).toHaveLength(1);
    expect(lines.some((l) => l.includes('tick failed'))).toBe(false);
    failRegister = false;
    (
      adapter as unknown as { registeredGeneration: number }
    ).registeredGeneration = 0;
    await vi.waitFor(() => {
      expect(
        (adapter as unknown as { loggedRegistrationFailure: boolean })
          .loggedRegistrationFailure,
      ).toBe(false);
    });
    await adapter.disconnect();
  });

  it('admission diagnostics are visible: refusal, policy-drop and stall transition/resume lines', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    // A deterministic refusal names the status.
    plane.setRefuseSubmit({ status: 400 });
    fake.push('poison', messageData({ msgid: 'poison' }));
    await adapter.tick();
    expect(
      lines.filter((l) =>
        l.includes('admission of wecom:poison was refused (400)'),
      ),
    ).toHaveLength(1);
    // A policy drop names the sender.
    plane.setRefuseSubmit(undefined);
    fake.push(
      'intruder',
      messageData({ msgid: 'intruder', from: { userid: 'intruder' } }),
    );
    await adapter.tick();
    expect(
      lines.some((l) => l.includes('sender intruder is not allowed')),
    ).toBe(true);
    // Stall transition then resume, one line each.
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('s1', messageData({ msgid: 's1' }));
    fake.push('s2', messageData({ msgid: 's2' }));
    await adapter.tick();
    expect(lines.filter((l) => l.includes('stopped admitting'))).toHaveLength(
      1,
    );
    plane.setRefuseSubmit(undefined);
    await adapter.tick();
    const resume = lines.filter((l) => l.includes('admission resumed'));
    expect(resume).toHaveLength(1);
    // This resume came from the held claim's FRESH admission, which proves the
    // binding and resets the refusal streak (submit() clears instanceRefusals
    // before lifting). The line must state that reset, not claim the streak
    // still stands — the latter is only true on a drop/replayed-answer lift.
    expect(resume[0]).toMatch(/refusal streak is reset/);
    await adapter.disconnect();
  });

  it('the no-claim-slot latch re-arms: a second outage after recovery logs again', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    const slotLines = () =>
      lines.filter((l) => l.includes('no durable claim slot'));
    for (let i = 0; i < MANAGED_WECOM_PENDING_LIMIT; i += 1) {
      fake.push(`m${i}`, messageData({ msgid: `m${i}` }));
    }
    fake.push('over', messageData({ msgid: 'over' }));
    expect(slotLines()).toHaveLength(1);
    // Recover: admit the backlog, freeing slots and re-arming the latch.
    await adapter.tick();
    expect(plane.submit.length).toBe(MANAGED_WECOM_PENDING_LIMIT);
    // Refill and trip the gate a second time.
    for (let i = 0; i < MANAGED_WECOM_PENDING_LIMIT; i += 1) {
      fake.push(`n${i}`, messageData({ msgid: `n${i}` }));
    }
    fake.push('over2', messageData({ msgid: 'over2' }));
    expect(slotLines()).toHaveLength(2);
    await adapter.disconnect();
  });

  it(
    'the ledger cap keeps the newest entries (identity, not just count)',
    { timeout: 20_000 },
    async () => {
      const { adapter, plane, fake } = await connectedAdapter();
      plane.setReceiptError(() =>
        Object.assign(new Error('lost'), { status: 503 }),
      );
      const ids = Array.from(
        { length: MANAGED_OUTBOUND_LIMIT + 1 },
        (_, i) => `d-${i}`,
      );
      plane.enqueue(ids.map((id) => delivery(id, 1)));
      // A conforming control plane returns at most the requested batch limit per
      // claim, so draining 65 deliveries takes several ticks — never one.
      for (let i = 0; i < ids.length && fake.sent.length < ids.length; i += 1) {
        await adapter.tick();
      }
      expect(fake.sent).toHaveLength(MANAGED_OUTBOUND_LIMIT + 1);
      const state = (
        adapter as unknown as {
          state: { outbound: Array<{ deliveryId: string }> };
        }
      ).state;
      // The oldest is evicted; the newest (just appended) survives.
      expect(state.outbound.map((e) => e.deliveryId)).toEqual(ids.slice(1));
      const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
      expect(
        persisted.outbound.map((e: { deliveryId: string }) => e.deliveryId),
      ).toEqual(ids.slice(1));
      await adapter.disconnect();
    },
  );

  it(
    'the recent window keeps the newest ids at exactly the cap',
    { timeout: 20_000 },
    async () => {
      const { adapter, plane, fake } = await connectedAdapter();
      const total = RECENT_LIMIT + 8;
      for (let i = 0; i < total; i += 1) {
        fake.push(`m${i}`, messageData({ msgid: `m${i}` }));
        await adapter.tick();
      }
      const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
      expect(persisted.recent).toHaveLength(RECENT_LIMIT);
      // The oldest ids are gone; the newest survive.
      expect(persisted.recent).not.toContain('wecom:m0');
      expect(persisted.recent).toContain(`wecom:m${total - 1}`);
      expect(plane.submit).toHaveLength(total);
      await adapter.disconnect();
    },
  );

  it('a settled segment is never re-sent: the orphan replay reports the receipt, not a send', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    // Fail the first receipt report so the entry stays in the ledger with its
    // ACCEPTED receipt persisted; the next report succeeds.
    let once = true;
    plane.setReceiptError(() => {
      if (once) {
        once = false;
        return Object.assign(new Error('lost'), { status: 503 });
      }
      return undefined;
    });
    plane.enqueue([delivery('d1', 1)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(0);
    // The next tick replays the persisted accepted receipt; never a second send.
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(1);
    expect(plane.receipts[0]!.receipt).toMatchObject({
      outcome: 'accepted',
      ordinal: 0,
    });
    await adapter.disconnect();
  });

  it('a stop before the pre-claim guard claims nothing', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    let claimCalls = 0;
    const origClaim = plane.controlPlane.claimDeliveries.bind(
      plane.controlPlane,
    );
    plane.controlPlane.claimDeliveries = async (limit) => {
      claimCalls += 1;
      return origClaim(limit);
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await adapter.connect();
    plane.enqueue([delivery('d1', 1)]);
    // Stop at an await that PRECEDES the pull (the submit phase), so the
    // pre-claim guard is reached with running=false.
    const origSubmit = plane.controlPlane.submitInbound.bind(
      plane.controlPlane,
    );
    plane.controlPlane.submitInbound = async (e) => {
      fake.kick();
      return origSubmit(e);
    };
    fake.push('m1', messageData({ msgid: 'm1' }));
    await adapter.tick();
    expect(claimCalls).toBe(0);
    expect(fake.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  it('the poll loop contains a transient tick error and recovers', async () => {
    const cwd = tempCwd();
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    // Seed an outcome-less orphan so reportOrphanedOutbound rethrows a 503.
    const seeder = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await seeder.connect();
    const priv = seeder as unknown as {
      state: { outbound: unknown[] };
      store: { save: (s: unknown) => void };
    };
    priv.state.outbound = [
      { deliveryId: 'd-orphan', ordinal: 0, messageId: 'm' },
    ];
    priv.store.save(priv.state);
    await seeder.disconnect();

    const lines: string[] = [];
    const plane2 = fakeControlPlane();
    let fail = true;
    plane2.setReceiptError(() =>
      fail
        ? Object.assign(new Error('unavailable'), { status: 503 })
        : undefined,
    );
    let claims = 0;
    const origClaim2 = plane2.controlPlane.claimDeliveries.bind(
      plane2.controlPlane,
    );
    plane2.controlPlane.claimDeliveries = async (limit) => {
      claims += 1;
      return origClaim2(limit);
    };
    const fake2 = fakeDeps();
    // Same name + cwd → same state dir → connect loads the persisted orphan.
    const looped = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: { ...CONFIG, pollInterval: 250 },
      controlPlane: plane2.controlPlane,
      deps: { ...fake2.deps, log: (l) => lines.push(l) },
      pollLoop: true,
    });
    await looped.connect();
    // R1-14: a PERSISTENT orphan-receipt refusal must not starve the outbox —
    // the orphan replay contains its transient error, so the tick still reaches
    // claimDeliveries and the loop keeps polling instead of aborting each tick.
    await vi.waitFor(() => {
      expect(claims).toBeGreaterThanOrEqual(1);
    });
    expect(lines.some((l) => l.includes('could not be reported'))).toBe(true);
    fail = false;
    await vi.waitFor(() => {
      expect(plane2.receipts.length).toBeGreaterThanOrEqual(1);
    });
    await looped.disconnect();
  });

  it('the claim batch is bounded and the socket connect/disconnect are observable', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const claimLimits: number[] = [];
    const origClaim = plane.controlPlane.claimDeliveries.bind(
      plane.controlPlane,
    );
    plane.controlPlane.claimDeliveries = async (limit) => {
      claimLimits.push(limit);
      return origClaim(limit);
    };
    let connects = 0;
    let disconnects = 0;
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps: {
        ...fake.deps,
        createStreamClient: (s, onMessage, onStopped) => {
          const inner = fake.deps.createStreamClient(s, onMessage, onStopped);
          return {
            connect: async () => {
              connects += 1;
              return inner.connect();
            },
            disconnect: () => {
              disconnects += 1;
              inner.disconnect();
            },
          };
        },
      },
      pollLoop: false,
    });
    await adapter.connect();
    expect(connects).toBe(1);
    // Enqueue more than the claim batch (16). The fake slices by the requested
    // limit, so one tick sends exactly the batch and leaves the rest queued —
    // witness the bounded send count, not just the limit argument.
    plane.enqueue(Array.from({ length: 20 }, (_, i) => delivery(`d${i}`, 1)));
    await adapter.tick();
    expect(claimLimits).toEqual([16]);
    expect(fake.sent).toHaveLength(16);
    // The next tick drains the remaining four.
    await adapter.tick();
    expect(fake.sent).toHaveLength(20);
    await adapter.disconnect();
    expect(disconnects).toBeGreaterThanOrEqual(1);
  });
});

describe('ManagedWecomAdapter — round-3 review fixes', () => {
  it('a kicked adapter releases its lock while parked and never disconnects the shared channel row', async () => {
    const cwd = tempCwd();
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    // A lock fake that records when the releaser runs, so the witness can tell
    // the kick released the lock (while parked) from a later disconnect.
    let releases = 0;
    let locked = false;
    const deps = {
      ...fake.deps,
      lock: async () => {
        locked = true;
        return async () => {
          releases += 1;
          locked = false;
        };
      },
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps,
      pollLoop: false,
    });
    await adapter.connect();
    expect(locked).toBe(true);
    expect(releases).toBe(0);
    // The server kicks this connection (a newer owner displaced it). The kick
    // must stop the adapter AND release the lock immediately — not hold it
    // until some later disconnect.
    fake.kick('new connection established');
    await vi.waitFor(() => {
      expect(releases).toBe(1);
    });
    expect(locked).toBe(false);
    // The row now belongs to the displacing owner. disconnect() must NOT call
    // controlPlane.disconnect() (that would 409 the new owner and drop frames
    // WeCom never redelivers); it only releases the (already released) lock.
    await adapter.disconnect();
    expect(plane.disconnectCalls()).toBe(0);
    expect(releases).toBe(1);
  });

  it('a normal disconnect still disconnects the channel row (the displaced guard is kick-only)', async () => {
    const { adapter, plane } = await connectedAdapter();
    await adapter.disconnect();
    expect(plane.disconnectCalls()).toBe(1);
  });

  it('a store failure on a skipped frame does not poison the durable-loss latch', async () => {
    const lines: string[] = [];
    const { adapter, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    const store = (
      adapter as unknown as { store: { save: (s: unknown) => void } }
    ).store;
    const spy = vi.spyOn(store, 'save').mockImplementation(() => {
      throw new Error('disk full');
    });
    // A group frame is deliberately skipped; its recent-window persist fails
    // but must be contained — not thrown into the durable-loss catch, which
    // would latch loggedAcceptFailure and blame a skipped frame for the loss.
    fake.push(
      'grp',
      messageData({ msgid: 'grp', chattype: 'group', chatid: 'group-1' }),
    );
    expect(
      lines.some((l) =>
        l.includes('could not record skipped message wecom:grp'),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('could not durably accept message grp')),
    ).toBe(false);
    // The next admittable text frame genuinely fails to stage; its OWN loss
    // line must still appear (the latch was not poisoned by the skipped frame).
    fake.push('m1', messageData({ msgid: 'm1' }));
    expect(
      lines.some((l) => l.includes('could not durably accept message m1')),
    ).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('the drop gate names the stall cause, not a claim slot', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    fake.push('m1', messageData({ msgid: 'm1' }));
    fake.push('m2', messageData({ msgid: 'm2' }));
    await adapter.tick(); // m1 sacrifice drop, m2 held + stall armed
    fake.push('drop', messageData({ msgid: 'drop' }));
    const dropLines = lines.filter((l) => l.includes('dropped message drop'));
    expect(dropLines).toHaveLength(1);
    expect(dropLines[0]).toContain(
      'admission is stalled (instance-scoped refusal)',
    );
    expect(dropLines[0]).not.toContain('no durable claim slot');
    await adapter.disconnect();
  });

  it('the drop gate names the re-registering cause, not a claim slot', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    plane.failNextSubmit(
      Object.assign(new Error('disconnected'), {
        status: 409,
        code: 'channel_disconnected',
      }),
    );
    fake.push('m1', messageData({ msgid: 'm1' }));
    await adapter.tick(); // registeredGeneration reset to 0
    fake.push('drop', messageData({ msgid: 'drop' }));
    const dropLines = lines.filter((l) => l.includes('dropped message drop'));
    expect(dropLines).toHaveLength(1);
    expect(dropLines[0]).toContain('the channel is re-registering');
    expect(dropLines[0]).not.toContain('no durable claim slot');
    await adapter.disconnect();
  });

  it('a cause change mid-outage emits a second drop line (re-registering to stall)', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    // Cause 1: a registration refusal resets the generation; both claims stay
    // pending and the gate drops new frames as "re-registering".
    plane.failNextSubmit(
      Object.assign(new Error('disconnected'), {
        status: 409,
        code: 'channel_disconnected',
      }),
    );
    fake.push('m1', messageData({ msgid: 'm1' }));
    fake.push('m2', messageData({ msgid: 'm2' }));
    await adapter.tick();
    fake.push('dropA', messageData({ msgid: 'dropA' }));
    // Cause 2: re-register, then consecutive instance-scoped refusals hold m2
    // and arm the stall. No frame is accepted between the two drops, so the
    // latch is still set and only the cause-change term can emit the 2nd line.
    plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    await adapter.tick();
    fake.push('dropB', messageData({ msgid: 'dropB' }));
    const dropLines = lines.filter((l) => l.includes('dropped message drop'));
    expect(dropLines).toHaveLength(2);
    expect(dropLines[0]).toContain('the channel is re-registering');
    expect(dropLines[1]).toContain(
      'admission is stalled (instance-scoped refusal)',
    );
    await adapter.disconnect();
  });
});

describe('ManagedWecomAdapter — round-4 review fixes', () => {
  it('a lock-compromised adapter does not deregister the shared channel row', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    // Capture the compromise callback the adapter hands to the lock dep.
    let compromise!: () => void;
    const deps = {
      ...fake.deps,
      lock: async (_directory: string, onCompromised: () => void) => {
        compromise = onCompromised;
        return async () => {};
      },
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps,
      pollLoop: false,
    });
    await adapter.connect();
    // Another process reaped the stale lock and now owns the row. This process
    // must not deregister it on shutdown (the server's disconnect has no
    // generation guard); the lock belongs to the new owner and is not released.
    compromise();
    await adapter.disconnect();
    expect(plane.disconnectCalls()).toBe(0);
  });

  it('a displaced adapter does not rewrite the state file the new owner holds', async () => {
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    // Gate sendMessage so a tick parks mid-send, after the pre-send persist.
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
    let sendStarted!: () => void;
    const started = new Promise<void>((resolve) => (sendStarted = resolve));
    const deps = {
      ...fake.deps,
      sendMessage: async (chatId: string, text: string) => {
        fake.sent.push({ chatId, text });
        sendStarted();
        await sendGate;
      },
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: CONFIG,
      controlPlane: plane.controlPlane,
      deps,
      pollLoop: false,
    });
    await adapter.connect();
    plane.enqueue([delivery('d1', 1)]);
    const tickPromise = adapter.tick();
    await started; // parked in sendMessage; the pre-send entry is on disk
    // The kick displaces this adapter and releases the lock; a restart (the
    // new owner) can now legitimately write the state file.
    fake.kick();
    await new Promise((resolve) => setImmediate(resolve));
    const sentinel = Buffer.from('new-owner-state-sentinel');
    writeFileSync(adapter.stateFile, sentinel);
    // The in-flight send returns and tries its post-send persist; the displaced
    // guard must suppress it so the new owner's bytes survive.
    releaseSend();
    await tickPromise;
    expect(readFileSync(adapter.stateFile)).toEqual(sentinel);
  });

  it('a transient orphan-receipt refusal on one entry does not starve the next', async () => {
    const { adapter, plane } = await connectedAdapter();
    const priv = adapter as unknown as {
      state: { outbound: unknown[] };
      store: { save: (s: unknown) => void };
    };
    priv.state.outbound = [
      { deliveryId: 'd1', ordinal: 0, messageId: 'm1' },
      { deliveryId: 'd2', ordinal: 0, messageId: 'm2' },
    ];
    priv.store.save(priv.state);
    // Only d1's receipt is persistently refused; d2's must still be reported.
    plane.setReceiptError((deliveryId) =>
      deliveryId === 'd1'
        ? Object.assign(new Error('unavailable'), { status: 503 })
        : undefined,
    );
    await adapter.tick();
    expect(plane.receipts.map((entry) => entry.deliveryId)).toEqual(['d2']);
    const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
    expect(
      persisted.outbound.map(
        (entry: { deliveryId: string }) => entry.deliveryId,
      ),
    ).toEqual(['d1']);
    await adapter.disconnect();
  });

  it('a 400 orphan-receipt refusal is a deterministic drop, not a transient keep', async () => {
    const { adapter, plane } = await connectedAdapter();
    const priv = adapter as unknown as {
      state: { outbound: unknown[] };
      store: { save: (s: unknown) => void };
    };
    priv.state.outbound = [{ deliveryId: 'd1', ordinal: 0, messageId: 'm1' }];
    priv.store.save(priv.state);
    plane.setReceiptError(() =>
      Object.assign(new Error('bad request'), { status: 400 }),
    );
    await adapter.tick();
    // 400 is in the deterministic-drop set: the entry is dropped, not kept for
    // re-drive (a transient keep would leave it persisted).
    const persisted = JSON.parse(readFileSync(adapter.stateFile, 'utf8'));
    expect(persisted.outbound).toEqual([]);
    await adapter.disconnect();
  });

  it('the poll loop contains a generic tick error and keeps polling', async () => {
    const lines: string[] = [];
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    let calls = 0;
    const origClaim = plane.controlPlane.claimDeliveries.bind(
      plane.controlPlane,
    );
    plane.controlPlane.claimDeliveries = async (limit) => {
      calls += 1;
      if (calls === 1) throw new Error('claim blew up');
      return origClaim(limit);
    };
    const adapter = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd: tempCwd(),
      config: { ...CONFIG, pollInterval: 250 },
      controlPlane: plane.controlPlane,
      deps: { ...fake.deps, log: (l) => lines.push(l) },
      pollLoop: true,
    });
    await adapter.connect();
    // The generic (non-registration) tick error is contained and logged, not
    // rethrown out of the loop (which would stop it via the outer finally).
    await vi.waitFor(() => {
      expect(lines.some((l) => l.includes('tick failed'))).toBe(true);
    });
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2);
    });
    await adapter.disconnect();
  });

  it('the policy-branch drop lifts a stall when the held claim leaves', async () => {
    const cwd = tempCwd();
    const first = await connectedAdapter(cwd);
    first.plane.setRefuseSubmit({ status: 404, code: 'workspace_not_found' });
    first.fake.push('m1', messageData({ msgid: 'm1' }));
    first.fake.push('m2', messageData({ msgid: 'm2' }));
    await first.adapter.tick(); // m1 sacrifice, m2 held + stall armed
    const stallOf = (a: ManagedWecomAdapter) =>
      (a as unknown as { instanceStalled: boolean }).instanceStalled;
    expect(stallOf(first.adapter)).toBe(true);
    await first.adapter.disconnect();
    // Restart with a policy that no longer allows the held claim's sender: the
    // policy arm drops the held claim and must lift the stall — no probe remains
    // and a flag kept armed would gate every later tick.
    const plane = fakeControlPlane();
    const fake = fakeDeps();
    const second = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: { ...CONFIG, allowedUsers: ['other-user'] },
      controlPlane: plane.controlPlane,
      deps: fake.deps,
      pollLoop: false,
    });
    await second.connect(); // restores the held claim and the stall
    expect(stallOf(second)).toBe(true);
    await second.tick();
    expect(stallOf(second)).toBe(false);
    expect(pendingOf(second)).toEqual([]);
    await second.disconnect();
  });
});

describe('ManagedWecomAdapter — outbound save-failure guards (P1)', () => {
  const storeOf = (a: ManagedWecomAdapter) =>
    (a as unknown as { store: { save: (s: unknown) => void } }).store;
  const stateOf = (a: ManagedWecomAdapter) =>
    (a as unknown as { state: { outbound: Array<{ receipt?: unknown }> } })
      .state;

  it('a failed ledger persist abandons the send before the side effect', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
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
    // No ledger on disk means no send may happen: the entry is the double-send
    // guard, and the rollback must clear memory too.
    expect(fake.sent).toHaveLength(0);
    expect(stateOf(adapter).outbound).toHaveLength(0);
    expect(
      JSON.parse(readFileSync(adapter.stateFile, 'utf8')).outbound,
    ).toHaveLength(0);
    expect(lines.some((l) => l.includes('outbound ledger'))).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed receipt persist still reports the accepted outcome', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
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
    // The send already happened: the server-side settle is the durable record,
    // so the accepted outcome must still be reported (never lost to unknown).
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(1);
    expect((plane.receipts[0]!.receipt as { outcome: string }).outcome).toBe(
      'accepted',
    );
    expect(lines.some((l) => l.includes('could not persist the receipt'))).toBe(
      true,
    );
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed settled-segment removal persist logs and keeps going', async () => {
    const lines: string[] = [];
    const { adapter, plane, fake } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    const store = storeOf(adapter);
    const realSave = store.save.bind(store);
    let saves = 0;
    const spy = vi.spyOn(store, 'save').mockImplementation((state: unknown) => {
      saves += 1;
      // For a one-segment delivery the tick saves the ledger append (1), the
      // post-send receipt (2), then the settled-segment removal (3).
      if (saves === 3) throw new Error('disk full');
      realSave(state);
    });
    plane.enqueue([delivery('d-1', 1)]);
    await adapter.tick();
    expect(fake.sent).toHaveLength(1);
    expect(plane.receipts).toHaveLength(1);
    expect(
      lines.some((l) => l.includes('could not persist the settled segment')),
    ).toBe(true);
    // The receipt is reported; disk keeps the entry for the orphan re-drive.
    expect(
      JSON.parse(readFileSync(adapter.stateFile, 'utf8')).outbound,
    ).toHaveLength(1);
    spy.mockRestore();
    await adapter.disconnect();
  });

  it('a failed orphan removal persist never aborts the remaining orphans', async () => {
    const lines: string[] = [];
    const { adapter, plane } = await connectedAdapter(tempCwd(), {
      log: (l) => lines.push(l),
    });
    const priv = adapter as unknown as {
      state: { outbound: unknown[] };
      store: { save: (s: unknown) => void };
    };
    priv.state.outbound = [
      {
        deliveryId: 'd1',
        ordinal: 0,
        messageId: 'm1',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: 'p1',
          acceptedAt: 1_750_000_000_000,
        },
      },
      {
        deliveryId: 'd2',
        ordinal: 0,
        messageId: 'm2',
        receipt: {
          outcome: 'accepted',
          ordinal: 0,
          providerMessageId: 'p2',
          acceptedAt: 1_750_000_000_000,
        },
      },
    ];
    priv.store.save(priv.state);
    const spy = vi.spyOn(priv.store, 'save').mockImplementation(() => {
      throw new Error('disk full');
    });
    await adapter.tick();
    // Both orphan receipts are reported despite every removal persist failing.
    expect(plane.receipts.map((r) => r.deliveryId)).toEqual(['d1', 'd2']);
    expect(lines.some((l) => l.includes('orphan removal'))).toBe(true);
    spy.mockRestore();
    await adapter.disconnect();
  });
});

describe('ManagedWecomAdapter — connection and destination guards (P1)', () => {
  it('pauses delivery claims while the connection is down, then delivers once after reconnect', async () => {
    const { adapter, plane, fake } = await connectedAdapter();
    plane.enqueue([delivery('d1', 1), delivery('d2', 1)]);
    // A transient SDK disconnect (reconnect backoff): the adapter stays running
    // but cannot send. The claim phase must pause, not claim batches it would
    // settle unknown.
    fake.setConnected(false);
    await adapter.tick();
    expect(fake.sent).toHaveLength(0);
    expect(plane.receipts).toHaveLength(0);
    // Reauthentication: both queued replies deliver exactly once, accepted.
    fake.setConnected(true);
    await adapter.tick();
    expect(fake.sent).toHaveLength(2);
    expect(plane.receipts).toHaveLength(2);
    expect(
      plane.receipts.every(
        (r) => (r.receipt as { outcome: string }).outcome === 'accepted',
      ),
    ).toBe(true);
    await adapter.disconnect();
  });

  it('a destination change never replays one tenant pending into another', async () => {
    const cwd = tempCwd();
    // Tenant A stages a pending claim (its admission answer has not landed).
    const planeA = fakeControlPlane('cp|tenant-a|chan-1');
    const fakeA = fakeDeps();
    const adapterA = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeA.controlPlane,
      deps: fakeA.deps,
      pollLoop: false,
    });
    await adapterA.connect();
    fakeA.push('m1', messageData({ msgid: 'm1' }));
    expect(pendingOf(adapterA)).toEqual(['wecom:m1']);
    const stateFileA = adapterA.stateFile;
    await adapterA.disconnect();

    // Restart the SAME configured entry against tenant B: a different
    // destination keys a different ledger FILE beneath the SAME entry directory
    // (the directory is the per-entry connection lock, not per-destination), so
    // A's pending claim is never loaded into B nor submitted under B's tenant
    // header.
    const planeB = fakeControlPlane('cp|tenant-b|chan-1');
    const fakeB = fakeDeps();
    const adapterB = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeB.controlPlane,
      deps: fakeB.deps,
      pollLoop: false,
    });
    await adapterB.connect();
    expect(adapterB.stateFile).not.toBe(stateFileA);
    // The isolation is file-deep, not directory-deep: both ledgers sit beneath
    // the one per-entry connection-lock directory (moving the destination term
    // back into the directory hash would let two instances of one bot entry
    // each take a lock and self-displace).
    expect(dirname(adapterB.stateFile)).toBe(dirname(stateFileA));
    expect(pendingOf(adapterB)).toEqual([]);
    await adapterB.tick();
    expect(planeB.submit).toHaveLength(0);
    await adapterB.disconnect();

    // A's pending claim is still available to A on its own restart.
    const planeA2 = fakeControlPlane('cp|tenant-a|chan-1');
    const fakeA2 = fakeDeps();
    const adapterA2 = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeA2.controlPlane,
      deps: fakeA2.deps,
      pollLoop: false,
    });
    await adapterA2.connect();
    expect(adapterA2.stateFile).toBe(stateFileA);
    expect(pendingOf(adapterA2)).toEqual(['wecom:m1']);
    await adapterA2.disconnect();
  });

  it('a second destination of the same bot entry is refused the connection lock', async () => {
    const cwd = tempCwd();
    const locked = new Set<string>();
    const lockFake = async (directory: string) => {
      if (locked.has(directory)) throw new Error('ELOCKED');
      locked.add(directory);
      return async () => {
        locked.delete(directory);
      };
    };
    const planeA = fakeControlPlane('cp|tenant-a|chan-1|actor|ws|.');
    const fakeA = fakeDeps();
    const adapterA = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeA.controlPlane,
      deps: { ...fakeA.deps, lock: lockFake },
      pollLoop: false,
    });
    await adapterA.connect();
    // Same bot entry, different destination: the connection lock is per entry,
    // so the second instance is refused before it can open a socket and displace
    // the first (WeCom admits one connection per bot and kicks the other).
    const planeB = fakeControlPlane('cp|tenant-b|chan-1|actor|ws|.');
    const fakeB = fakeDeps();
    const adapterB = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeB.controlPlane,
      deps: { ...fakeB.deps, lock: lockFake },
      pollLoop: false,
    });
    await expect(adapterB.connect()).rejects.toThrow(
      'owned by another process',
    );
    expect(fakeB.sent).toHaveLength(0);
    await adapterA.disconnect();
  });

  it('a workspace change within one tenant never replays the prior owner pending', async () => {
    const cwd = tempCwd();
    const planeA = fakeControlPlane('cp|tenant-a|chan-1|actor|ws-a|.');
    const fakeA = fakeDeps();
    const adapterA = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeA.controlPlane,
      deps: fakeA.deps,
      pollLoop: false,
    });
    await adapterA.connect();
    fakeA.push('m1', messageData({ msgid: 'm1' }));
    expect(pendingOf(adapterA)).toEqual(['wecom:m1']);
    const stateFileA = adapterA.stateFile;
    await adapterA.disconnect();
    // Same tenant/channel, different workspace: the ledger follows the
    // registration ownership, so B opens a different ledger and submits nothing
    // of A's under B's actor/workspace.
    const planeB = fakeControlPlane('cp|tenant-a|chan-1|actor|ws-b|.');
    const fakeB = fakeDeps();
    const adapterB = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeB.controlPlane,
      deps: fakeB.deps,
      pollLoop: false,
    });
    await adapterB.connect();
    expect(adapterB.stateFile).not.toBe(stateFileA);
    // The isolation is file-deep, not directory-deep: both ledgers sit beneath
    // the one per-entry connection-lock directory (moving the destination term
    // back into the directory hash would let two instances of one bot entry
    // each take a lock and self-displace).
    expect(dirname(adapterB.stateFile)).toBe(dirname(stateFileA));
    expect(pendingOf(adapterB)).toEqual([]);
    await adapterB.tick();
    expect(planeB.submit).toHaveLength(0);
    await adapterB.disconnect();
    // A's pending claim is still available to A on its own restart.
    const planeA2 = fakeControlPlane('cp|tenant-a|chan-1|actor|ws-a|.');
    const fakeA2 = fakeDeps();
    const adapterA2 = new ManagedWecomAdapter({
      name: 'wecom-1',
      cwd,
      config: CONFIG,
      controlPlane: planeA2.controlPlane,
      deps: fakeA2.deps,
      pollLoop: false,
    });
    await adapterA2.connect();
    expect(adapterA2.stateFile).toBe(stateFileA);
    expect(pendingOf(adapterA2)).toEqual(['wecom:m1']);
    await adapterA2.disconnect();
  });
});
