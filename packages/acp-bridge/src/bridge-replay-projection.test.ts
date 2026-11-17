/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './eventBus.js';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';

describe('load replay projection metadata', () => {
  it('captures the seed boundary for full loads and omits it on summary reads', async () => {
    const handle = makeChannel({
      loadSessionImpl: () => ({
        _meta: {
          'qwen.session.loadReplay': {
            v: 1,
            updates: [
              {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'saved' },
              },
            ],
          },
        },
      }),
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const request = {
      sessionId: 'projection-load',
      workspaceCwd: WS_A,
      historyReplay: 'response' as const,
    };
    try {
      const full = await bridge.loadSession(request);
      expect(full.replayProjectionWatermark).toBe(full.lastEventId);
      expect(full.replayProjectionWatermark).toBeGreaterThan(0);
      expect(full.eventEpoch).toBeTruthy();
      for (const mode of ['liveReplayMode', 'compactedReplayMode'] as const) {
        const summary = await bridge.loadSession({
          ...request,
          [mode]: 'summary',
        });
        expect(summary.replayProjectionWatermark).toBeUndefined();
      }
      const again = await bridge.loadSession(request);
      expect(again.replayProjectionWatermark).toBe(
        full.replayProjectionWatermark,
      );
      expect(again.lastEventId).toBe(full.lastEventId);
      expect(
        (await bridge.resumeSession(request)).replayProjectionWatermark,
      ).toBeUndefined();
    } finally {
      await bridge.shutdown();
    }
  });

  it('rechecks a refreshed page when filtering changed only the projection boundary', async () => {
    let bus: EventBus | undefined;
    const snapshot = vi.spyOn(EventBus.prototype, 'snapshotReplay');
    let pages = 0;
    const handle = makeChannel({
      extMethodImpl: (_method, params) => {
        pages += 1;
        if (pages === 1) {
          bus!.setEventDetailMode('summary');
          expect(
            bus!.publish({
              type: 'session_update',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'filtered' },
                  _meta: { parentToolCallId: 'parent' },
                },
              },
            }),
          ).toBeUndefined();
          bus!.setEventDetailMode('full');
        }
        return {
          v: 1,
          sessionId: params['sessionId'],
          events: [
            {
              v: 1,
              type: 'session_update',
              data: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: `page-${pages}` },
              },
            },
          ],
          hasMore: false,
        };
      },
    });
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const request = {
      sessionId: 'projection-refresh',
      workspaceCwd: WS_A,
      historyReplay: 'response' as const,
    };
    try {
      await bridge.loadSession(request);
      const captured = snapshot.mock.contexts[0];
      if (!(captured instanceof EventBus)) {
        throw new Error('Load did not capture its event bus');
      }
      bus = captured;
      bus!.publish({ type: 'text', data: 'checkpoint' });
      const before = bus!.lastEventId;
      const refreshed = await bridge.loadSession({
        ...request,
        historyPageSize: 10,
      });
      expect(pages).toBe(2);
      expect(refreshed.lastEventId).toBe(before);
      expect(JSON.stringify(refreshed.compactedReplay)).toContain('page-2');
      expect(refreshed.replayProjectionWatermark).toBeUndefined();
    } finally {
      snapshot.mockRestore();
      await bridge.shutdown();
    }
  });
});
