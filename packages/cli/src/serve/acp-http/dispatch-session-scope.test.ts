/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  makeBridge,
  makeChannel,
  WS_A,
} from '@qwen-code/acp-bridge/internal/testUtils';
import { AcpDispatcher } from './dispatch.js';

describe('real dispatch notification session scope', () => {
  it.each([
    'stream_error',
    'client_evicted',
    'slow_client_warning',
    'state_resync_required',
    'replay_complete',
    'model_switched',
    'model_switch_failed',
    'mcp_budget_warning',
    'mcp_child_refused_batch',
    'history_truncated',
    'terminal_sequence',
    'permission_resolved',
  ])('%s carries its owning session in the wire envelope', (type) => {
    const sendSession = vi.fn();
    const dispatcher = Object.create(AcpDispatcher.prototype) as {
      translateEvent: (
        conn: unknown,
        sessionId: string,
        event: BridgeEvent,
      ) => void;
    };
    dispatcher.translateEvent({ sendSession }, 'owner', {
      type,
      data: { reason: 'test', error: 'test' },
    } as BridgeEvent);
    expect(sendSession).toHaveBeenCalledTimes(1);
    const [sessionId, notification] = sendSession.mock.calls[0]!;
    expect(sessionId).toBe('owner');
    expect(notification).toMatchObject({
      jsonrpc: '2.0',
      method: '_qwen/notify',
      params: { sessionId: 'owner', kind: type },
    });
  });

  it.each(['memory_changed', 'settings_changed'] as const)(
    'keeps real workspace %s publications unscoped on each session bus',
    async (type) => {
      let channelIndex = 0;
      const bridge = makeBridge({
        channelFactory: async () =>
          makeChannel({ sessionIdPrefix: `session-${++channelIndex}` }).channel,
      });
      const abort = new AbortController();
      try {
        const sessions = await Promise.all([
          bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionScope: 'thread' }),
          bridge.spawnOrAttach({ workspaceCwd: WS_A, sessionScope: 'thread' }),
        ]);
        expect(sessions[0]!.sessionId).not.toBe(sessions[1]!.sessionId);
        const received = sessions.map(async ({ sessionId }) => {
          for await (const event of bridge.subscribeEvents(sessionId, {
            signal: abort.signal,
          })) {
            if (event.type === type) return event;
          }
          throw new Error('workspace publication was not received');
        });
        await new Promise((resolve) => setImmediate(resolve));
        const data =
          type === 'memory_changed'
            ? {
                scope: 'workspace',
                filePath: '/work/QWEN.md',
                mode: 'append',
                bytesWritten: 5,
              }
            : { key: 'mcp' };
        bridge.publishWorkspaceEvent({ type, data });

        const events = await Promise.all(received);
        for (const [index, event] of events.entries()) {
          const sendSession = vi.fn();
          const dispatcher = Object.create(AcpDispatcher.prototype) as {
            translateEvent: (
              conn: unknown,
              sessionId: string,
              event: BridgeEvent,
            ) => void;
          };
          dispatcher.translateEvent(
            { sendSession },
            sessions[index]!.sessionId,
            event,
          );
          const notification = sendSession.mock.calls[0]![1];
          expect(notification.params.sessionId).toBeUndefined();
          expect(notification.params).toEqual({ kind: type, data });
          expect(notification.params.data.sessionId).toBeUndefined();
        }
      } finally {
        abort.abort();
        await bridge.shutdown();
      }
    },
  );

  it('retains the real MCP publisher session in its settings notification', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const abort = new AbortController();
    try {
      const { sessionId } = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const received = (async () => {
        for await (const event of bridge.subscribeEvents(sessionId, {
          signal: abort.signal,
        })) {
          if (event.type === 'settings_changed') return event;
        }
        throw new Error('MCP settings notification was not received');
      })();
      await new Promise((resolve) => setImmediate(resolve));
      await handle.agentConnection.extNotification(
        'qwen/notify/session/mcp-changed',
        { sessionId },
      );
      const sendSession = vi.fn();
      const dispatcher = Object.create(AcpDispatcher.prototype) as {
        translateEvent: (
          conn: unknown,
          sessionId: string,
          event: BridgeEvent,
        ) => void;
      };
      dispatcher.translateEvent({ sendSession }, sessionId, await received);
      expect(sendSession).toHaveBeenCalledTimes(1);
      expect(sendSession.mock.calls[0]![0]).toBe(sessionId);
      expect(sendSession.mock.calls[0]![1]).toMatchObject({
        method: '_qwen/notify',
        params: {
          kind: 'settings_changed',
          data: { sessionId, key: 'mcp' },
        },
      });
    } finally {
      abort.abort();
      await bridge.shutdown();
    }
  });

  it('preserves the origin of a workspace-fanned approval-mode change', () => {
    const sendSession = vi.fn();
    const dispatcher = Object.create(AcpDispatcher.prototype) as {
      translateEvent: (
        conn: unknown,
        sessionId: string,
        event: BridgeEvent,
      ) => void;
    };
    const data = { sessionId: 'origin', mode: 'default' };
    dispatcher.translateEvent({ sendSession }, 'peer', {
      type: 'approval_mode_changed',
      data,
    });
    const notification = sendSession.mock.calls[0]![1];
    expect(notification.params).toEqual({
      kind: 'approval_mode_changed',
      data,
    });
    expect(notification.params.sessionId).toBeUndefined();
    expect(notification.params.data.sessionId).toBe('origin');
  });
});
