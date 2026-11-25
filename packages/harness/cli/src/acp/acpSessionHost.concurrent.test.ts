/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import type { Config, SDKMessage } from '@qwen-code/core';
import { createAcpSessionHost } from './acpSessionHost.js';
import { createDefaultAcpModelAdapter } from './acpSupport.js';

describe('ACP concurrent prompt lifecycle', () => {
  function fixture() {
    const connection = {
      sessionUpdate: vi.fn(async () => ({})),
    } as unknown as acp.AgentSideConnection;
    const config = {
      toolCallSnapshots: {
        subscribeToolCallSnapshots: vi.fn(() => () => {}),
      },
      getToolRegistry: () => ({ getTool: () => undefined }),
    } as unknown as Config;
    const { host, state } = createAcpSessionHost({
      sessionId: 'session-1',
      cwd: '/workspace',
      clientCapabilities: undefined,
      mcpServers: [],
      additionalDirectories: [],
      modelAdapter: createDefaultAcpModelAdapter(),
      connection,
      ensureAuthReady: async () => {},
      resolveConfig: () => config,
      setModeForExitPlan: async () => {},
    });
    state.active = true;
    function lifecycle(
      commandUuid: string,
      commandState: 'started' | 'completed' | 'cancelled',
      engine = false,
    ) {
      if (engine) {
        host.events.emit({
          kind: 'threadMessage',
          message: {
            type: 'command_lifecycle',
            command_uuid: commandUuid,
            state: commandState,
            uuid: 'lifecycle-frame',
            session_id: 'session-1',
          },
        });
      } else {
        host.events.emit({
          kind: 'commandLifecycle',
          commandUuid,
          state: commandState,
        });
      }
    }
    function result(value: Record<string, unknown>) {
      host.events.emit({
        kind: 'threadMessage',
        message: { type: 'result', ...value } as unknown as SDKMessage,
      });
    }
    return { host, state, connection, lifecycle, result };
  }

  it('settles consumed prompts with the turn without stealing output or duplicating usage', async () => {
    const { host, state, connection, lifecycle, result } = fixture();
    const main = host.beginPrompt('main', 'hello');
    lifecycle('main', 'started');
    await state.eventChain;
    const publisher = state.toolPublisher;
    const injected = ['injected-1', 'injected-2'].map((uuid) => {
      const handle = host.beginPrompt(uuid, 'stop');
      host.events.emit({
        kind: 'threadMessage',
        message: {
          type: 'user',
          uuid,
          isReplay: true,
          session_id: 'session-1',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: 'stop' }] },
        },
      });
      lifecycle(uuid, 'started', true);
      return handle;
    });
    const queued = host.beginPrompt('queued', 'next turn');
    await state.eventChain;
    expect(state.activeCommandUuid).toBe('main');
    expect(state.toolPublisher).toBe(publisher);
    host.events.emit({
      kind: 'threadMessage',
      message: {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'INJECTED-OK' },
        },
      } as unknown as SDKMessage,
    });
    // Core emits these before the runner creates the result frame.
    lifecycle('injected-1', 'completed', true);
    lifecycle('injected-2', 'completed', true);
    await state.eventChain;
    expect(state.pendingCommands.get('injected-1')?.finalized).toBe(false);
    expect(state.toolPublisher).toBe(publisher);
    result({
      subtype: 'success',
      num_turns: 2,
      usage: { input_tokens: 12, output_tokens: 3 },
      modelUsage: { 'test-model': { inputTokens: 12, outputTokens: 3 } },
    });
    lifecycle('main', 'completed');
    await expect(main.promise).resolves.toMatchObject({
      usage: { totalTokens: 15 },
    });
    const responses = await Promise.all(
      injected.map((handle) => handle.promise),
    );
    expect(responses.map((response) => response.userMessageId)).toEqual([
      'injected-1',
      'injected-2',
    ]);
    for (const response of responses) {
      expect(response).toMatchObject({
        stopReason: 'end_turn',
        usage: { totalTokens: 0 },
        _meta: { quota: { model_usage: [] } },
      });
    }
    expect(connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
        }),
      }),
    );
    expect([...state.pendingCommands.keys()]).toEqual(['queued']);
    lifecycle('queued', 'started');
    result({
      subtype: 'success',
      num_turns: 1,
      usage: { input_tokens: 4, output_tokens: 1 },
    });
    lifecycle('queued', 'completed');
    await expect(queued.promise).resolves.toMatchObject({
      usage: { totalTokens: 5 },
    });
    lifecycle('injected-1', 'completed', true);
    await state.eventChain;
    expect(state.pendingCommands.size).toBe(0);
  });

  it.each([
    ['refusal', { subtype: 'success', stop_reason: 'refusal' }],
    ['max_turn_requests', { subtype: 'error_max_turns' }],
  ])(
    'propagates %s instead of prematurely returning end_turn',
    async (reason, outcome) => {
      const { host, state, lifecycle, result } = fixture();
      const main = host.beginPrompt('main', 'hello');
      const injected = host.beginPrompt('injected', 'stop');
      lifecycle('main', 'started');
      lifecycle('injected', 'started', true);
      lifecycle('injected', 'completed', true);
      await state.eventChain;
      expect(state.pendingCommands.has('injected')).toBe(true);
      result(outcome);
      lifecycle('main', 'completed');
      await expect(main.promise).resolves.toMatchObject({ stopReason: reason });
      await expect(injected.promise).resolves.toMatchObject({
        stopReason: reason,
      });
    },
  );

  it.each([
    ['result error', 500],
    ['budget', 429],
    ['turnFailed', 502],
  ])(
    'returns a correlated error for all consumed prompts on %s',
    async (source, code) => {
      const { host, state, lifecycle, result } = fixture();
      const main = host.beginPrompt('main', 'hello');
      const injected = host.beginPrompt('injected', 'stop');
      const settled = Promise.allSettled([main.promise, injected.promise]);
      lifecycle('main', 'started');
      lifecycle('injected', 'started', true);
      lifecycle('injected', 'cancelled', true);
      if (source === 'turnFailed') {
        host.events.emit({
          kind: 'turnFailed',
          error: Object.assign(new Error('upstream failed'), { status: 502 }),
        });
      } else {
        result(
          source === 'budget'
            ? { subtype: 'error_max_budget_usd' }
            : {
                subtype: 'error_during_execution',
                errors: ['upstream failed'],
              },
        );
        lifecycle('main', source === 'budget' ? 'completed' : 'cancelled');
      }
      await state.eventChain;
      for (const value of await settled) {
        expect(value.status).toBe('rejected');
        if (value.status === 'rejected') expect(value.reason.code).toBe(code);
      }
      expect(state.pendingCommands.size).toBe(0);
    },
  );

  it('cancels an unconsumed command without destroying the active tool publisher', async () => {
    const { host, state, lifecycle } = fixture();
    const main = host.beginPrompt('main', 'hello');
    lifecycle('main', 'started');
    await state.eventChain;
    const publisher = state.toolPublisher;
    const dropped = host.beginPrompt('dropped', 'not consumed');
    lifecycle('dropped', 'cancelled', true);
    lifecycle('unknown', 'completed', true);
    await expect(dropped.promise).resolves.toMatchObject({
      stopReason: 'cancelled',
    });
    expect(state.toolPublisher).toBe(publisher);
    expect(state.activeCommandUuid).toBe('main');
    const injected = host.beginPrompt('injected', 'stop');
    lifecycle('injected', 'started', true);
    lifecycle('injected', 'cancelled', true);
    lifecycle('main', 'cancelled');
    await expect(main.promise).resolves.toMatchObject({
      stopReason: 'cancelled',
    });
    await expect(injected.promise).resolves.toMatchObject({
      stopReason: 'cancelled',
    });
  });

  it('settles a real prompt consumed during an internal background turn', async () => {
    const { host, state, lifecycle, result } = fixture();
    host.events.emit({
      kind: 'messageReplay',
      commandUuid: 'background',
      message: { type: 'user', isSynthetic: true },
    });
    await state.eventChain;
    const injected = host.beginPrompt('injected', 'stop');
    lifecycle('injected', 'started', true);
    lifecycle('injected', 'completed', true);
    result({ subtype: 'success', stop_reason: 'refusal' });
    await expect(injected.promise).resolves.toMatchObject({
      stopReason: 'refusal',
    });
    expect(state.pendingCommands.size).toBe(0);
  });

  it.each(['result', 'turnFailed'])('rejects a prompt consumed by a failed background turn (%s)', async (source) => {
    const { host, state, lifecycle, result } = fixture();
    host.events.emit({ kind: 'messageReplay', commandUuid: 'background', message: { type: 'user', isSynthetic: true } });
    await state.eventChain;
    const injected = host.beginPrompt('injected', 'stop');
    const settled = Promise.allSettled([injected.promise]);
    lifecycle('injected', 'started', true);
    if (source === 'result') result({ subtype: 'error_during_execution', errors: ['upstream failed'] });
    else host.events.emit({ kind: 'turnFailed', error: new Error('upstream failed') });
    await state.eventChain;
    expect((await settled)[0]).toMatchObject({ status: 'rejected', reason: { code: 500 } });
    expect(state.pendingCommands.size).toBe(0);
  });

  it.each(['cancel', 'dispose'])(
    'cleans up all pending prompts on %s',
    async (action) => {
      const { host, state, lifecycle } = fixture();
      const handles = ['main', 'injected', 'queued'].map((uuid) =>
        host.beginPrompt(uuid, 'hello'),
      );
      lifecycle('main', 'started');
      lifecycle('injected', 'started', true);
      await state.eventChain;
      if (action === 'cancel') await host.cancelPendingPrompts();
      else await host.dispose();
      for (const handle of handles)
        await expect(handle.promise).resolves.toMatchObject({
          stopReason: 'cancelled',
        });
      expect(state.pendingCommands.size).toBe(0);
    },
  );
});
