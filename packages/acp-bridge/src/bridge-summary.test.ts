/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import type { BridgeEvent } from './eventBus.js';

describe('summary API without persistence acknowledgements', () => {
  it('projects cold and attached load responses without modifying full history', async () => {
    const updates = [
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'main prompt' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'nested detail' },
        _meta: { parentToolCallId: 'agent-1' },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'agent-1',
        title: 'Agent',
        kind: 'other',
        status: 'completed',
        rawOutput: {
          type: 'task_execution',
          result: 'final answer',
          tokenCount: 123,
          toolCalls: ['nested-tool'],
        },
      },
    ];
    const original = structuredClone(updates);
    const handle = makeChannel({
      loadSessionImpl: () => ({
        _meta: { 'qwen.session.loadReplay': { v: 1, updates } },
      }),
      extMethodImpl: (_method, params) => ({
        v: 1,
        sessionId: params['sessionId'],
        events: updates.map((data) => ({ v: 1, type: 'session_update', data })),
        hasMore: false,
      }),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    try {
      const request = {
        sessionId: 'summary-api',
        workspaceCwd: WS_A,
        historyReplay: 'response' as const,
        historyPageSize: 200,
      };
      for (const mode of ['summary', 'full', 'summary'] as const) {
        const loaded = await bridge.loadSession({
          ...request,
          compactedReplayMode: mode,
        });
        const replay = JSON.stringify(loaded.compactedReplay);
        expect(replay).toContain('main prompt');
        expect(replay).toContain('final answer');
        expect(replay.includes('nested detail')).toBe(mode === 'full');
        expect(replay).toContain('tokenCount');
      }
      expect(updates).toEqual(original);
    } finally {
      await bridge.shutdown();
    }
  });

  it('rejects invalid modes before channel creation or prompt admission', async () => {
    const channelFactory = vi.fn(async () => makeChannel().channel);
    const bridge = makeBridge({ channelFactory });
    try {
      await expect(
        bridge.loadSession({
          sessionId: 'invalid',
          workspaceCwd: WS_A,
          compactedReplayMode: 'invalid' as never,
        }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(() =>
        bridge.sendPrompt('invalid', {
          sessionId: 'invalid',
          prompt: [{ type: 'text', text: 'hello' }],
          eventDetailMode: 'invalid' as never,
        }),
      ).toThrow('Invalid eventDetailMode');
      expect(channelFactory).not.toHaveBeenCalled();
    } finally {
      await bridge.shutdown();
    }
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ['full', true],
  ['summary', true],
  ['full', false],
  ['summary', false],
] as const)(
  'preserves %s queued mode without changing the running prompt (mid-turn=%s)',
  async (mode, midTurn) => {
    const held = gate();
    const promoted = gate();
    const events: BridgeEvent[] = [];
    const handle = makeChannel({
      promptImpl: async (p, agent) => {
        const first = agent.promptCalls.length === 1;
        await (first ? held.promise : promoted.promise);
        await handle.agentConnection.sessionUpdate({
          sessionId: p.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: first ? 'first-child' : 'next-child',
            },
            _meta: { parentToolCallId: 'agent' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    let collect: Promise<void> | undefined;
    try {
      const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      collect = (async () => {
        for await (const event of bridge.subscribeEvents(sessionId))
          events.push(event);
      })();
      const first = bridge.sendPrompt(sessionId, {
        sessionId,
        prompt: [{ type: 'text', text: 'held' }],
        eventDetailMode: mode === 'summary' ? 'full' : 'summary',
      });
      await vi.waitFor(() => expect(handle.agent.promptCalls).toHaveLength(1));
      const enqueue = (eventDetailMode: 'full' | 'summary' | undefined) =>
        bridge.enqueueMidTurnMessage(sessionId, 'follow up', undefined, 'mid', {
          eventDetailMode,
        });
      const queued = midTurn
        ? undefined
        : bridge.sendPrompt(
            sessionId,
            {
              sessionId,
              prompt: [{ type: 'text', text: 'follow up' }],
              eventDetailMode: mode,
            },
            undefined,
            { promptId: 'mid' },
          );
      if (midTurn) {
        expect(enqueue(mode).accepted).toBe(true);
        expect(enqueue(mode).accepted).toBe(true);
        expect(enqueue(mode === 'summary' ? 'full' : 'summary').accepted).toBe(
          false,
        );
        expect(enqueue(undefined).accepted).toBe(mode === 'full');
      }
      held.resolve();
      await first;
      await vi.waitFor(() => expect(handle.agent.promptCalls).toHaveLength(2));
      if (midTurn) {
        expect(enqueue(mode).accepted).toBe(true);
        expect(enqueue(mode === 'summary' ? 'full' : 'summary').accepted).toBe(
          false,
        );
      }
      promoted.resolve();
      await queued;
      await vi.waitFor(() =>
        expect(
          events.some(
            (e) => e.type === 'turn_complete' && e.promptId === 'mid',
          ),
        ).toBe(true),
      );
      expect(JSON.stringify(events).includes('first-child')).toBe(
        mode === 'summary',
      );
      expect(JSON.stringify(events).includes('next-child')).toBe(
        mode === 'full',
      );
      expect(
        handle.agent.promptCalls.every((p) => !('eventDetailMode' in p)),
      ).toBe(true);
    } finally {
      held.resolve();
      promoted.resolve();
      await bridge.shutdown();
      await collect;
    }
  },
);

it.each(['idle', 'drain'] as const)(
  'handles summary mid-turn %s without changing an existing turn',
  async (path) => {
    const held = gate();
    const events: BridgeEvent[] = [];
    const handle = makeChannel({
      promptImpl: async (p) => {
        await held.promise;
        await handle.agentConnection.sessionUpdate({
          sessionId: p.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'child-probe' },
            _meta: { parentToolCallId: 'agent' },
          },
        });
        return { stopReason: 'end_turn' };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    let collect: Promise<void> | undefined;
    try {
      const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      collect = (async () => {
        for await (const e of bridge.subscribeEvents(sessionId)) events.push(e);
      })();
      const running =
        path === 'drain'
          ? bridge.sendPrompt(sessionId, {
              sessionId,
              prompt: [{ type: 'text', text: 'held' }],
            })
          : undefined;
      if (running)
        await vi.waitFor(() =>
          expect(handle.agent.promptCalls).toHaveLength(1),
        );
      expect(
        bridge.enqueueMidTurnMessage(sessionId, 'follow up', undefined, 'mid', {
          eventDetailMode: 'summary',
        }).accepted,
      ).toBe(true);
      if (running)
        await handle.agentConnection.extMethod('craft/drainMidTurnQueue', {
          sessionId,
        });
      held.resolve();
      await running;
      await vi.waitFor(() =>
        expect(events.some((e) => e.type === 'turn_complete')).toBe(true),
      );
      expect(handle.agent.promptCalls).toHaveLength(1);
      expect(JSON.stringify(events).includes('child-probe')).toBe(
        path === 'drain',
      );
    } finally {
      held.resolve();
      await bridge.shutdown();
      await collect;
    }
  },
);

it.each(['success', 'error', 'cancel'] as const)(
  'restores full after a summary prompt %s',
  async (outcome) => {
    const held = gate();
    const events: BridgeEvent[] = [];
    const handle = makeChannel({
      promptImpl: async (p, agent) => {
        if (agent.promptCalls.length === 1) {
          await held.promise;
          if (outcome === 'error') throw new Error('provider failed');
          return {
            stopReason: outcome === 'cancel' ? 'cancelled' : 'end_turn',
          };
        }
        await handle.agentConnection.sessionUpdate({
          sessionId: p.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'default-full-child' },
            _meta: { parentToolCallId: 'agent' },
          },
        });
        return { stopReason: 'end_turn' };
      },
      cancelImpl: () => held.resolve(),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    let collect: Promise<void> | undefined;
    try {
      const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      collect = (async () => {
        for await (const e of bridge.subscribeEvents(sessionId)) events.push(e);
      })();
      const first = bridge
        .sendPrompt(sessionId, {
          sessionId,
          prompt: [{ type: 'text', text: 'first' }],
          eventDetailMode: 'summary',
        })
        .catch((e: unknown) => e);
      await vi.waitFor(() => expect(handle.agent.promptCalls).toHaveLength(1));
      if (outcome === 'cancel') await bridge.cancelSession(sessionId);
      else held.resolve();
      const result = await first;
      if (outcome === 'error') expect(result).toMatchObject({ code: -32603 });
      else
        expect(result).toMatchObject({
          stopReason: outcome === 'cancel' ? 'cancelled' : 'end_turn',
        });
      await handle.agentConnection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'idle-full-child' },
          _meta: { parentToolCallId: 'agent' },
        },
      });
      await vi.waitFor(() =>
        expect(JSON.stringify(events)).toContain('idle-full-child'),
      );
      await bridge.sendPrompt(sessionId, {
        sessionId,
        prompt: [{ type: 'text', text: 'next' }],
      });
      await vi.waitFor(() =>
        expect(JSON.stringify(events)).toContain('default-full-child'),
      );
    } finally {
      held.resolve();
      await bridge.shutdown();
      await collect;
    }
  },
);

it('reports invalid mid-turn mode in the diagnostic message', async () => {
  const handle = makeChannel();
  const bridge = makeBridge({ channelFactory: async () => handle.channel });
  try {
    const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    expect(() =>
      bridge.enqueueMidTurnMessage(sessionId, 'hello', undefined, undefined, {
        eventDetailMode: 'invalid' as never,
      }),
    ).toThrow('Invalid eventDetailMode');
    expect(handle.agent.promptCalls).toHaveLength(0);
  } finally {
    await bridge.shutdown();
  }
});

it('projects late child events using the mode at publication, not the originating prompt', async () => {
  let held = gate();
  const events: BridgeEvent[] = [];
  const handle = makeChannel({
    promptImpl: async () => {
      await held.promise;
      return { stopReason: 'end_turn' };
    },
  });
  const bridge = makeBridge({ channelFactory: async () => handle.channel });
  let collect: Promise<void> | undefined;
  try {
    const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
    collect = (async () => {
      for await (const event of bridge.subscribeEvents(sessionId))
        events.push(event);
    })();
    const publishLate = async (label: string) => {
      await handle.agentConnection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: label },
          _meta: { parentToolCallId: 'agent-from-first-prompt' },
        },
      });
      await handle.agentConnection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `checkpoint-${label}` },
        },
      });
      await vi.waitFor(() =>
        expect(JSON.stringify(events)).toContain(`checkpoint-${label}`),
      );
      return events.some((event) => {
        const data = event.data as { update?: { content?: { text?: string } } };
        return data?.update?.content?.text === label;
      });
    };
    for (const [index, mode] of (
      ['summary', 'full', 'summary'] as const
    ).entries()) {
      held = gate();
      const prompt = bridge.sendPrompt(sessionId, {
        sessionId,
        prompt: [{ type: 'text', text: `prompt-${index}` }],
        eventDetailMode: mode,
      });
      await vi.waitFor(() =>
        expect(handle.agent.promptCalls).toHaveLength(index + 1),
      );
      expect(await publishLate(`late-${index}`)).toBe(mode === 'full');
      held.resolve();
      await prompt;
      expect(await publishLate(`idle-${index}`)).toBe(true);
    }
  } finally {
    held.resolve();
    await bridge.shutdown();
    await collect;
  }
});
