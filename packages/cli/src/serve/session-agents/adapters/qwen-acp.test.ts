/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapterEvent,
  SessionAgentPermissionPrompt,
} from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';
import { AGENT_SESSION_SOURCE_TYPE } from '../../../runtime/agent-session-source.js';
import { createQwenAcpAdapter, type QwenAcpAdapterBridge } from './qwen-acp.js';

const WS = '/ws';
const AGENT_ID = 'ag_alice';
const SESSION_ID = 'agent-session-1';

/** A session event stream the test feeds by hand. */
function eventFeed() {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  return {
    push(event: unknown) {
      queue.push(event);
      wake?.();
    },
    async *subscribeEvents(_sessionId: string, opts: { signal: AbortSignal }) {
      while (!opts.signal.aborted) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          opts.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        wake = undefined;
      }
    },
  };
}

/**
 * A bridge whose turn keeps "thinking": `sendPrompt` never settles on its
 * own (it settles only when the turn ends; set `promptSettles` for a turn
 * that ends) and the turn stays `running` until the test ends it.
 */
function thinkingBridge() {
  const feed = eventFeed();
  const turn: {
    promptId?: string;
    state: 'running' | 'completed' | 'cancelled';
    promptSettles?: boolean;
  } = {
    state: 'running',
  };
  const bridge = {
    listWorkspaceSessions: vi.fn(() => [
      {
        sessionId: SESSION_ID,
        sourceType: AGENT_SESSION_SOURCE_TYPE,
        sourceId: AGENT_ID,
        hasActivePrompt: true,
      },
    ]),
    spawnOrAttach: vi.fn(),
    resumeSession: vi.fn(),
    closeSession: vi.fn(async () => {}),
    subscribeEvents: vi.fn(feed.subscribeEvents),
    sendPrompt: vi.fn(
      (
        _sessionId: string,
        _req: unknown,
        _signal: AbortSignal | undefined,
        context: { promptId?: string } | undefined,
      ) => {
        turn.promptId = context?.promptId;
        return turn.promptSettles
          ? Promise.resolve()
          : new Promise<void>(() => {});
      },
    ),
    cancelSession: vi.fn(async () => {}),
    getSessionTurnStatus: vi.fn(async () =>
      turn.promptId
        ? { sessionId: SESSION_ID, promptId: turn.promptId, state: turn.state }
        : undefined,
    ),
    respondToSessionPermission: vi.fn(() => true),
    getSessionStatsStatus: vi.fn(async () => {
      throw new Error('no stats');
    }),
  };
  const permissionEvent = (requestId: string) => ({
    type: 'permission_request',
    promptId: turn.promptId,
    data: {
      requestId,
      toolCall: { title: 'Run marker', kind: 'execute' },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
  return { bridge, feed, turn, permissionEvent };
}

describe('createQwenAcpAdapter', () => {
  it('cancels the native turn when the run is stopped, and refuses its permission requests', async () => {
    const { bridge, feed, turn, permissionEvent } = thinkingBridge();
    const adapter = createQwenAcpAdapter({
      bridge: bridge as unknown as QwenAcpAdapterBridge,
      workspaceCwd: WS,
      agentId: AGENT_ID,
      idleCloseMs: 60_000,
      sessionExists: async () => true,
    });
    const controller = new AbortController();
    const events: AgentAdapterEvent[] = [];
    const asked: string[] = [];
    // Like the orchestrator: an open question is rejected when the run stops.
    const awaitPermission = (prompt: SessionAgentPermissionPrompt) =>
      new Promise<string>((_resolve, reject) => {
        asked.push(prompt.requestId);
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error('cancelled')),
          { once: true },
        );
      });
    const result = adapter.runTurn({
      prompt: 'think hard',
      nativeSessionId: SESSION_ID,
      cwd: WS,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
      awaitPermission,
    });

    await vi.waitFor(() => expect(turn.promptId).toBeDefined());
    // The stop signal reaches the bridge with the prompt.
    expect(bridge.sendPrompt.mock.calls[0]![2]).toBe(controller.signal);
    feed.push(permissionEvent('p1'));
    await vi.waitFor(() => expect(asked).toEqual(['p1']));

    controller.abort();
    await vi.waitFor(() =>
      expect(bridge.cancelSession).toHaveBeenCalledWith(SESSION_ID),
    );
    // The open question is answered `cancelled`, so the turn can wind down.
    await vi.waitFor(() =>
      expect(bridge.respondToSessionPermission).toHaveBeenCalledWith(
        SESSION_ID,
        'p1',
        { outcome: { outcome: 'cancelled' } },
        undefined,
      ),
    );

    // Winding down, the turn asks again: refused, never shown.
    feed.push(permissionEvent('p2'));
    await vi.waitFor(() =>
      expect(bridge.respondToSessionPermission).toHaveBeenCalledWith(
        SESSION_ID,
        'p2',
        { outcome: { outcome: 'cancelled' } },
        undefined,
      ),
    );
    expect(asked).toEqual(['p1']);
    expect(
      events.flatMap((event) =>
        event.type === 'permission_request' ? [event.prompt.requestId] : [],
      ),
    ).toEqual(['p1']);

    turn.state = 'cancelled';
    await expect(result).resolves.toMatchObject({
      status: 'cancelled',
      nativeSessionId: SESSION_ID,
    });
    // The pending `sendPrompt` never settled: the adapter stopped waiting.
    expect(bridge.cancelSession).toHaveBeenCalledTimes(1);
  });

  it('drops its stop listener from the run signal when the turn completes', async () => {
    const { bridge, turn } = thinkingBridge();
    turn.state = 'completed';
    turn.promptSettles = true;
    const adapter = createQwenAcpAdapter({
      bridge: bridge as unknown as QwenAcpAdapterBridge,
      workspaceCwd: WS,
      agentId: AGENT_ID,
      idleCloseMs: 60_000,
      sessionExists: async () => true,
    });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(
      adapter.runTurn({
        prompt: 'quick one',
        nativeSessionId: SESSION_ID,
        cwd: WS,
        signal: controller.signal,
        onEvent: () => {},
        awaitPermission: () => new Promise<string>(() => {}),
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    const listeners = added.mock.calls
      .filter(([type]) => type === 'abort')
      .map(([, listener]) => listener);
    expect(listeners).toHaveLength(1);
    expect(removed).toHaveBeenCalledWith('abort', listeners[0]);
    // Stopping the (reused) signal later reaches no ended turn.
    controller.abort();
    expect(bridge.cancelSession).not.toHaveBeenCalled();
  });

  it('reports cancelled when the turn does not settle in time after a stop', async () => {
    const { bridge, turn } = thinkingBridge();
    const adapter = createQwenAcpAdapter({
      bridge: bridge as unknown as QwenAcpAdapterBridge,
      workspaceCwd: WS,
      agentId: AGENT_ID,
      idleCloseMs: 60_000,
      cancelSettleMs: 300,
      sessionExists: async () => true,
    });
    const controller = new AbortController();
    const result = adapter.runTurn({
      prompt: 'think hard',
      nativeSessionId: SESSION_ID,
      cwd: WS,
      signal: controller.signal,
      onEvent: () => {},
      awaitPermission: () => new Promise<string>(() => {}),
    });
    await vi.waitFor(() => expect(turn.promptId).toBeDefined());
    controller.abort();
    // The turn never reaches its terminal; the run still ends.
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
    expect(bridge.cancelSession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('reports the JSON-RPC error detail when the prompt fails', async () => {
    const { bridge } = thinkingBridge();
    // A provider 400 reaches the bridge as a generic internal error whose
    // detail is in `data.details`.
    bridge.sendPrompt.mockImplementation(async () => {
      throw Object.assign(new Error('Internal error'), {
        code: -32603,
        data: { details: '400 Bad Request: model qwen-x not found' },
      });
    });
    const adapter = createQwenAcpAdapter({
      bridge: bridge as unknown as QwenAcpAdapterBridge,
      workspaceCwd: WS,
      agentId: AGENT_ID,
      idleCloseMs: 60_000,
      sessionExists: async () => true,
    });
    const result = await adapter.runTurn({
      prompt: 'go',
      nativeSessionId: SESSION_ID,
      cwd: WS,
      signal: new AbortController().signal,
      onEvent: () => {},
      awaitPermission: () => new Promise<string>(() => {}),
    });
    expect(result).toMatchObject({ status: 'failed' });
    expect(result.error).toBe('400 Bad Request: model qwen-x not found');
  });

  it('puts overlapping permission requests to the person one at a time, without "always"', async () => {
    const { bridge, feed, turn, permissionEvent } = thinkingBridge();
    const adapter = createQwenAcpAdapter({
      bridge: bridge as unknown as QwenAcpAdapterBridge,
      workspaceCwd: WS,
      agentId: AGENT_ID,
      idleCloseMs: 60_000,
      cancelSettleMs: 50,
      sessionExists: async () => true,
    });
    const controller = new AbortController();
    const shown: string[] = [];
    const answers = new Map<string, (optionId: string) => void>();
    const result = adapter.runTurn({
      prompt: 'go',
      nativeSessionId: SESSION_ID,
      cwd: WS,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'permission_request') {
          shown.push(event.prompt.requestId);
        }
      },
      awaitPermission: (prompt) =>
        new Promise<string>((resolve) =>
          answers.set(prompt.requestId, resolve),
        ),
    });
    await vi.waitFor(() => expect(turn.promptId).toBeDefined());
    const first = permissionEvent('p1');
    // The hidden session is pinned to the default approval mode, so an
    // "always" grant cannot take effect there: it is not offered.
    first.data.options.unshift({
      optionId: 'always',
      name: 'Allow All Edits',
      kind: 'allow_always',
    });
    feed.push(first);
    feed.push(permissionEvent('p2'));
    await vi.waitFor(() => expect(shown).toEqual(['p1']));
    expect(answers.size).toBe(1);
    answers.get('p1')!('yes');
    await vi.waitFor(() => expect(shown).toEqual(['p1', 'p2']));
    expect(bridge.respondToSessionPermission).toHaveBeenCalledWith(
      SESSION_ID,
      'p1',
      { outcome: { outcome: 'selected', optionId: 'yes' } },
      undefined,
    );
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('offers no allow_always option', async () => {
    const { bridge, feed, turn, permissionEvent } = thinkingBridge();
    const adapter = createQwenAcpAdapter({
      bridge: bridge as unknown as QwenAcpAdapterBridge,
      workspaceCwd: WS,
      agentId: AGENT_ID,
      idleCloseMs: 60_000,
      cancelSettleMs: 50,
      sessionExists: async () => true,
    });
    const controller = new AbortController();
    const prompts: SessionAgentPermissionPrompt[] = [];
    const result = adapter.runTurn({
      prompt: 'go',
      nativeSessionId: SESSION_ID,
      cwd: WS,
      signal: controller.signal,
      onEvent: () => {},
      awaitPermission: (prompt) => {
        prompts.push(prompt);
        return new Promise<string>(() => {});
      },
    });
    await vi.waitFor(() => expect(turn.promptId).toBeDefined());
    const event = permissionEvent('p1');
    event.data.options.unshift({
      optionId: 'always',
      name: 'Allow All Edits',
      kind: 'allow_always',
    });
    feed.push(event);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]!.options.map((option) => option.kind)).toEqual([
      'allow_once',
      'reject_once',
    ]);
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('clips a permission prompt title like the other adapters', async () => {
    const { bridge, feed, turn, permissionEvent } = thinkingBridge();
    const adapter = createQwenAcpAdapter({
      bridge: bridge as unknown as QwenAcpAdapterBridge,
      workspaceCwd: WS,
      agentId: AGENT_ID,
      idleCloseMs: 60_000,
      cancelSettleMs: 50,
      sessionExists: async () => true,
    });
    const controller = new AbortController();
    const prompts: SessionAgentPermissionPrompt[] = [];
    const result = adapter.runTurn({
      prompt: 'go',
      nativeSessionId: SESSION_ID,
      cwd: WS,
      signal: controller.signal,
      onEvent: () => {},
      awaitPermission: (prompt) => {
        prompts.push(prompt);
        return new Promise<string>(() => {});
      },
    });
    await vi.waitFor(() => expect(turn.promptId).toBeDefined());
    const event = permissionEvent('p1');
    event.data.toolCall.title = 'r'.repeat(5_000);
    feed.push(event);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]!.title).toBe('r'.repeat(200));
    controller.abort();
    await expect(result).resolves.toMatchObject({ status: 'cancelled' });
  });
});
