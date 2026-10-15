/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import {
  ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
  ACTIVE_WORK_HEARTBEAT_META_KEY,
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HOLD_CATEGORIES,
  ACTIVE_WORK_NOTIFICATION_METHOD,
  CHANNEL_LIVENESS_META_KEY,
} from './bridgeTypes.js';
import { CHANNEL_LIVENESS_INTERVAL_MS } from './channel-liveness.js';
import { SERVE_STATUS_EXT_METHODS } from './status.js';

describe('channel handshake', () => {
  it.each([2, '1'])(
    'does not enable optional capabilities for unsupported version %s',
    async (version) => {
      vi.useFakeTimers();
      const handle = makeChannel({
        initializeImpl: () => ({
          protocolVersion: PROTOCOL_VERSION,
          _meta: {
            [ACTIVE_WORK_HEARTBEAT_META_KEY]: {
              v: version,
              intervalMs: ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
              categories: [...ACTIVE_WORK_HOLD_CATEGORIES],
            },
            [CHANNEL_LIVENESS_META_KEY]: { v: version },
          },
        }),
      });
      const bridge = makeBridge({ channelFactory: async () => handle.channel });

      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        expect(
          bridge.getSessionSummary(session.sessionId).activeWorkState,
        ).toBe('unsupported');
        expect(bridge.activeWorkCoverage.onNegotiatedChannel).toBe(0);
        await vi.advanceTimersByTimeAsync(CHANNEL_LIVENESS_INTERVAL_MS * 2);
        expect(handle.agent.extMethodCalls).not.toContainEqual(
          expect.objectContaining({
            method: SERVE_STATUS_EXT_METHODS.channelPing,
          }),
        );
        expect(handle.killed).toBe(false);
      } finally {
        await bridge.shutdown();
        vi.useRealTimers();
      }
    },
  );

  it('retains snapshot sequencing before the initialize span finishes', async () => {
    const sendSnapshot = async (seq: number) => {
      await handle.agentConnection.extNotification(
        ACTIVE_WORK_NOTIFICATION_METHOD,
        {
          v: ACTIVE_WORK_HEARTBEAT_VERSION,
          seq,
          sessions: [
            {
              sessionId: 'early-active-work',
              holds: [{ category: 'agent', id: 'early-agent' }],
            },
          ],
        },
      );
    };
    const handle = makeChannel({
      initializeImpl: () => ({
        protocolVersion: PROTOCOL_VERSION,
        _meta: {
          [ACTIVE_WORK_HEARTBEAT_META_KEY]: {
            v: ACTIVE_WORK_HEARTBEAT_VERSION,
            intervalMs: ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
            categories: [...ACTIVE_WORK_HOLD_CATEGORIES],
          },
        },
      }),
      newSessionImpl: async () => {
        await sendSnapshot(1);
        return { sessionId: 'early-active-work' };
      },
    });
    const bridge = makeBridge({
      channelFactory: async () => handle.channel,
      telemetry: {
        captureContext: () => undefined,
        runWithContext: async (_captured, fn) => await fn(),
        withSpan: async (operation, _attributes, fn) => {
          const result = await fn();
          if (operation === 'channel.initialize') {
            await handle.agentConnection.extNotification(
              ACTIVE_WORK_NOTIFICATION_METHOD,
              {
                v: ACTIVE_WORK_HEARTBEAT_VERSION,
                seq: 2,
                sessions: [],
              },
            );
          }
          return result;
        },
        event: () => {},
        injectPromptContext: (request) => request,
      },
    });

    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      expect(bridge.getSessionSummary(session.sessionId).activeWorkState).toBe(
        'unknown',
      );
      expect(bridge.activeWorkCoverage.covered).toBe(0);
      await sendSnapshot(3);
      expect(bridge.getSessionSummary(session.sessionId).activeWorkState).toBe(
        'active',
      );
      expect(bridge.activeWorkCoverage.covered).toBe(1);
    } finally {
      await bridge.shutdown();
    }
  });
});
