/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MID_TURN_LEASE_META_KEY,
  MID_TURN_QUEUE_DRAIN_METHOD,
  MID_TURN_QUEUE_RECOVER_METHOD,
  MID_TURN_QUEUE_SETTLE_METHOD,
  MID_TURN_RECOVERY_PENDING_META_KEY,
  type AcpSessionBridge,
  type BridgeMidTurnOutcome,
} from './bridgeTypes.js';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import { readCommittedMidTurnMessages } from './mid-turn-commit-ledger.js';

describe('mid-turn delivery arbitration', () => {
  let runtimeDir: string;
  let bridge: AcpSessionBridge;

  beforeEach(async () => {
    runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'mid-turn-delivery-'));
  });

  afterEach(async () => {
    await bridge?.shutdown();
    await rm(runtimeDir, { recursive: true, force: true });
  });

  function deferredPrompt() {
    let resolve!: (response: PromptResponse) => void;
    const promise = new Promise<PromptResponse>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function start() {
    const release = deferredPrompt();
    const channel = makeChannel({
      promptImpl: (_, self) =>
        self.promptCalls.length === 1
          ? release.promise
          : { stopReason: 'end_turn' },
      cancelImpl: () => release.resolve({ stopReason: 'cancelled' }),
    });
    bridge = makeBridge({
      artifactSnapshotRuntimeBaseDir: runtimeDir,
      channelFactory: async () => channel.channel,
    });
    const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    const { sessionId, clientId } = session;
    const context = { clientId };
    const current = bridge.sendPrompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: 'Start' }],
      },
      undefined,
      { ...context, promptId: 'turn' },
    );
    void current.catch(() => {});
    await vi.waitFor(() => expect(channel.agent.promptCalls).toHaveLength(1));
    const target = bridge.getMidTurnMessages(sessionId, context).target!;
    const enqueue = (messageId: string) =>
      bridge.enqueueMidTurnMessage(
        sessionId,
        ` ${messageId} `,
        context,
        messageId,
        { target },
      );
    const claim = async () => {
      const response = await channel.agentConnection.extMethod(
        MID_TURN_QUEUE_DRAIN_METHOD,
        {
          sessionId,
          promptId: target.promptId,
          leaseUserInput: true,
        },
      );
      const items = response['items'] as Array<{
        messageId: string;
        leaseId: string;
      }>;
      return items;
    };
    const settle = (leaseId: string, outcomes: BridgeMidTurnOutcome[]) =>
      channel.agentConnection.extMethod(MID_TURN_QUEUE_SETTLE_METHOD, {
        sessionId,
        leaseId,
        outcomes,
      });
    return {
      channel,
      current,
      release,
      session,
      context,
      enqueue,
      claim,
      settle,
      target,
    };
  }

  const allow = (messageId: string): BridgeMidTurnOutcome => ({
    messageId,
    kind: 'allow',
    parts: [{ text: `${messageId} with hook context` }],
    displayText: messageId,
    hookContext: 'hook context',
  });

  it('publishes only the durably accepted items of a mixed batch', async () => {
    const { current, release, session, context, enqueue, claim, settle } =
      await start();
    const { sessionId } = session;
    const subscription = new AbortController();
    const events = bridge
      .subscribeEvents(sessionId, { signal: subscription.signal })
      [Symbol.asyncIterator]();
    for (const id of ['commit', 'reject', 'error', 'remove'])
      expect(enqueue(id).accepted).toBe(true);
    const items = await claim();
    expect(items).toHaveLength(4);
    expect(new Set(items.map(({ leaseId }) => leaseId)).size).toBe(1);
    expect(
      bridge.getMidTurnMessages(sessionId, context).settledMessageIds,
    ).toEqual([]);
    expect(readCommittedMidTurnMessages(WS_A, sessionId, runtimeDir)).toEqual(
      [],
    );
    expect(bridge.removeMidTurnMessage(sessionId, 'remove', context)).toEqual({
      removed: true,
    });
    expect(
      await settle(items[0]!.leaseId, [
        allow('commit'),
        allow('remove'),
        { messageId: 'reject', kind: 'reject', reason: 'Policy rejected' },
        { messageId: 'error', kind: 'error', reason: 'Hook timed out' },
      ]),
    ).toEqual({ committedMessageIds: ['commit'] });
    expect(readCommittedMidTurnMessages(WS_A, sessionId, runtimeDir)).toEqual([
      expect.objectContaining({
        messageId: 'commit',
        originalText: ' commit ',
        hookContext: 'hook context',
      }),
    ]);
    expect(bridge.getMidTurnMessages(sessionId, context).recoveries).toEqual([
      { messageId: 'error', text: ' error ', error: 'Hook timed out' },
    ]);
    const echo = await (async () => {
      for (;;) {
        const result = await events.next();
        if (result.done || result.value.type === 'mid_turn_message_injected')
          return result.value;
      }
    })();
    expect(echo).toMatchObject({
      promptId: 'turn',
      data: { messageIds: ['commit'] },
    });
    subscription.abort();
    release.resolve({ stopReason: 'end_turn' });
    await current;
  });

  it('revokes a claimed message and rejects late admission while keeping an ordinary queued turn', async () => {
    const {
      channel,
      current,
      session,
      context,
      enqueue,
      claim,
      settle,
      target,
    } = await start();
    const { sessionId } = session;
    expect(enqueue('claimed').accepted).toBe(true);
    const [leased] = await claim();
    expect(enqueue('waiting').accepted).toBe(true);
    const heldSuccessor = deferredPrompt();
    const dispatch = channel.agent.prompt.bind(channel.agent);
    vi.spyOn(channel.agent, 'prompt').mockImplementation(async (request) => {
      await dispatch(request);
      return heldSuccessor.promise;
    });
    const queued = bridge.sendPrompt(
      sessionId,
      {
        sessionId,
        prompt: [{ type: 'text', text: 'ordinary successor' }],
      },
      undefined,
      { ...context, promptId: 'ordinary-successor' },
    );
    await bridge.cancelSession(sessionId, { sessionId }, context);
    await vi.waitFor(() => expect(channel.agent.promptCalls).toHaveLength(2));
    expect(
      bridge.enqueueMidTurnMessage(
        sessionId,
        'unbound late',
        context,
        'unbound',
      ),
    ).toEqual({ accepted: false, reason: 'turn_cancelled' });
    const successorTarget = bridge.getMidTurnMessages(
      sessionId,
      context,
    ).target!;
    expect(successorTarget.promptId).toBe('ordinary-successor');
    expect(
      bridge.enqueueMidTurnMessage(
        sessionId,
        'new input',
        context,
        'new-input',
        { target: successorTarget },
      ).accepted,
    ).toBe(true);
    expect(
      bridge.removeMidTurnMessage(sessionId, 'new-input', context).removed,
    ).toBe(true);
    expect(await settle(leased!.leaseId, [allow('claimed')])).toEqual({
      committedMessageIds: [],
    });
    expect(
      bridge.enqueueMidTurnMessage(sessionId, 'late', context, 'late', {
        target,
      }),
    ).toEqual({ accepted: false, reason: 'turn_cancelled' });
    const other = await bridge.loadSession({ workspaceCwd: WS_A, sessionId });
    expect(
      bridge.getMidTurnMessages(sessionId, { clientId: other.clientId })
        .recoveries,
    ).toBeUndefined();
    expect(
      bridge.consumeMidTurnRecoveries(sessionId, ['claimed'], {
        clientId: other.clientId,
      }).consumedMessageIds,
    ).toEqual([]);
    expect(
      bridge
        .getMidTurnMessages(sessionId, context)
        .recoveries?.map(({ messageId }) => messageId),
    ).toEqual(['claimed', 'waiting']);
    expect(
      bridge.consumeMidTurnRecoveries(sessionId, ['claimed'], context)
        .consumedMessageIds,
    ).toEqual(['claimed']);
    expect(
      bridge.getMidTurnMessages(sessionId, context, 'claimed').disposition,
    ).toBe('owned');
    heldSuccessor.resolve({ stopReason: 'end_turn' });
    await Promise.all([current, queued]);
    expect(channel.agent.promptCalls).toHaveLength(2);
    expect(readCommittedMidTurnMessages(WS_A, sessionId, runtimeDir)).toEqual(
      [],
    );
  });

  it('recovers only committed content into a replacement child before its next prompt', async () => {
    const { channel, current, session, context, enqueue, claim, settle } =
      await start();
    const { sessionId } = session;
    expect(enqueue('committed').accepted).toBe(true);
    const [leased] = await claim();
    expect(await settle(leased!.leaseId, [allow('committed')])).toEqual({
      committedMessageIds: ['committed'],
    });
    expect(enqueue('draft').accepted).toBe(true);
    channel.crash({ exitCode: 1, signalCode: null });
    await current.catch(() => {});
    await bridge.shutdown();
    const recovered = vi.fn();
    const replacement = makeChannel({
      extMethodImpl: async (method, params) => {
        if (method === MID_TURN_QUEUE_RECOVER_METHOD) {
          recovered(params['messages']);
          return { recordedMessageIds: ['committed'] };
        }
        return {};
      },
    });
    bridge = makeBridge({
      artifactSnapshotRuntimeBaseDir: runtimeDir,
      channelFactory: async () => replacement.channel,
    });
    const restored = await bridge.resumeSession({
      sessionId,
      workspaceCwd: WS_A,
      ...context,
    });
    expect(restored.clientId).toBe(context.clientId);
    expect(
      replacement.agent.resumeSessionCalls[0]?._meta?.[
        MID_TURN_RECOVERY_PENDING_META_KEY
      ],
    ).toBe(true);
    expect(recovered).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        messageId: 'committed',
        hookContext: 'hook context',
      }),
    ]);
    expect(bridge.getMidTurnMessages(sessionId, context).recoveries).toEqual([
      {
        messageId: 'draft',
        text: ' draft ',
        error: expect.stringContaining('exited'),
      },
    ]);
    expect(readCommittedMidTurnMessages(WS_A, sessionId, runtimeDir)).toEqual(
      [],
    );
  });

  it('returns a superseded Goal lease to its owner and ignores its late verdict', async () => {
    const channel = makeChannel();
    bridge = makeBridge({
      artifactSnapshotRuntimeBaseDir: runtimeDir,
      channelFactory: async () => channel.channel,
    });
    const { sessionId, clientId } = await bridge.spawnOrAttach({
      workspaceCwd: WS_A,
    });
    const context = { clientId };
    const startGoal = (turnId: string) =>
      channel.agentConnection.extNotification('_qwencode/start_turn', {
        sessionId,
        source: 'goal',
        turnId,
      });
    await startGoal('goal-before');
    await vi.waitFor(() =>
      expect(
        bridge.getMidTurnMessages(sessionId, context).target?.promptId,
      ).toBe('goal-before'),
    );
    const target = bridge.getMidTurnMessages(sessionId, context).target!;
    expect(
      bridge.enqueueMidTurnMessage(
        sessionId,
        'held by prior goal',
        context,
        'prior',
        { target },
      ).accepted,
    ).toBe(true);
    const response = await channel.agentConnection.extMethod(
      MID_TURN_QUEUE_DRAIN_METHOD,
      { sessionId, promptId: target.promptId, leaseUserInput: true },
    );
    const [item] = response['items'] as Array<{ leaseId: string }>;
    await startGoal('goal-after');
    await vi.waitFor(() =>
      expect(
        bridge.getMidTurnMessages(sessionId, context).recoveries,
      ).toMatchObject([{ messageId: 'prior', text: 'held by prior goal' }]),
    );
    expect(
      await channel.agentConnection.extMethod(MID_TURN_QUEUE_SETTLE_METHOD, {
        sessionId,
        leaseId: item!.leaseId,
        outcomes: [allow('prior')],
      }),
    ).toEqual({ committedMessageIds: [] });
  });

  it('opens a lease for natural promotion and suppresses its chat echo before commit', async () => {
    const { channel, current, release, session, context, enqueue } =
      await start();
    const { sessionId } = session;
    const held = deferredPrompt();
    const original = channel.agent.prompt.bind(channel.agent);
    vi.spyOn(channel.agent, 'prompt').mockImplementation(async (request) => {
      await held.promise;
      return original(request);
    });
    expect(enqueue('next').accepted).toBe(true);
    release.resolve({ stopReason: 'end_turn' });
    await current;
    await vi.waitFor(() => expect(channel.agent.prompt).toHaveBeenCalledOnce());
    const next = vi.mocked(channel.agent.prompt).mock.calls[0]![0];
    expect(next._meta?.[MID_TURN_LEASE_META_KEY]).toEqual({
      messageId: 'next',
      leaseId: expect.any(String),
    });
    expect(bridge.getMidTurnMessages(sessionId, context).messages).toEqual([
      { messageId: 'next', text: 'next' },
    ]);
    expect(bridge.getPendingPrompts(sessionId, context)).toEqual([]);
    expect(bridge.removeMidTurnMessage(sessionId, 'next', context)).toEqual({
      removed: true,
    });
    held.resolve({ stopReason: 'end_turn' });
  });
});
