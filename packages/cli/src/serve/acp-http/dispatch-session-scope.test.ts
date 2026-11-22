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
import {
  denormalizeAcpNotification,
  filterEventsBySession,
} from '../../../../sdk-typescript/src/daemon/AcpEventDenormalizer.js';

describe('real dispatch notification session scope', () => {
  it.each([
    'stream_error',
    'client_evicted',
    'slow_client_warning',
    'state_resync_required',
    'replay_complete',
    'model_switched',
    'model_switch_failed',
    'permission_resolved',
  ])('%s stays in its owning session after SDK denormalization', (type) => {
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
    const event = denormalizeAcpNotification(notification)!;
    expect([...filterEventsBySession([event], 'foreign')]).toEqual([]);
    expect([...filterEventsBySession([event], 'owner')]).toEqual([event]);
    expect(notification.params.sessionId).toBe('owner');
  });

  it('keeps real workspace publications visible to both session subscribers', async () => {
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
          if (event.type === 'memory_changed') return event;
        }
        throw new Error('workspace publication was not received');
      });
      await new Promise((resolve) => setImmediate(resolve));
      const data = {
        scope: 'workspace',
        filePath: '/work/QWEN.md',
        mode: 'append',
        bytesWritten: 5,
      };
      bridge.publishWorkspaceEvent({ type: 'memory_changed', data });

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
        const normalized = denormalizeAcpNotification(notification)!;
        expect(normalized.data).toEqual(data);
        for (const { sessionId } of sessions) {
          expect([...filterEventsBySession([normalized], sessionId)]).toEqual([
            normalized,
          ]);
        }
      }
    } finally {
      abort.abort();
      await bridge.shutdown();
    }
  });
});
