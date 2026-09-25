/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from './eventBus.js';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';

describe('daemon embedded-resource admission', () => {
  it('rejects an oversized direct text resource before the peer echo or child prompt', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    const abort = new AbortController();
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const events: BridgeEvent[] = [];
      const collecting = (async () => {
        for await (const event of bridge.subscribeEvents(session.sessionId, {
          signal: abort.signal,
        })) {
          events.push(event);
        }
      })();

      await expect(
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [
            {
              type: 'resource',
              resource: {
                uri: 'context://example/oversized',
                text: 'x'.repeat(256 * 1024),
              },
            },
          ],
        }),
      ).rejects.toThrow(
        'Embedded text resources exceed the 256 KiB replay limit',
      );
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'turn_error')).toBe(true),
      );
      expect(handle.agent.promptCalls).toHaveLength(0);
      expect(
        events.filter((event) => {
          if (event.type !== 'session_update') return false;
          return (
            (event.data as { update?: { sessionUpdate?: string } }).update
              ?.sessionUpdate === 'user_message_chunk'
          );
        }),
      ).toEqual([]);
      abort.abort();
      await collecting;
    } finally {
      abort.abort();
      await bridge.shutdown();
    }
  });

  it('accepts a large daemon-native text attachment without applying the inline replay limit', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const reference = await bridge.storeSessionAttachment(
        session.sessionId,
        new TextEncoder().encode('x'.repeat(256 * 1024)),
        'text/plain',
        { clientId: session.clientId },
        'large-notes.txt',
      );
      await expect(
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [reference],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(handle.agent.promptCalls).toHaveLength(1);
      expect(handle.agent.promptCalls[0]).toMatchObject({
        prompt: [
          {
            type: 'resource',
            resource: {
              uri: 'attachment:///large-notes.txt',
              text: expect.any(String),
            },
          },
        ],
        _meta: { 'qwen.daemon.attachmentResourceIndexes': [0] },
      });
    } finally {
      await bridge.shutdown();
    }
  });

  it('does not exempt a direct oversized resource just because it shares a native attachment URI', async () => {
    const handle = makeChannel();
    const bridge = makeBridge({ channelFactory: async () => handle.channel });
    try {
      const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
      const reference = await bridge.storeSessionAttachment(
        session.sessionId,
        new TextEncoder().encode('native'),
        'text/plain',
        { clientId: session.clientId },
        'notes.txt',
      );
      await expect(
        bridge.sendPrompt(session.sessionId, {
          sessionId: session.sessionId,
          prompt: [
            reference,
            {
              type: 'resource',
              resource: {
                uri: 'attachment:///notes.txt',
                text: 'x'.repeat(256 * 1024),
              },
            },
          ],
        }),
      ).rejects.toThrow(
        'Embedded text resources exceed the 256 KiB replay limit',
      );
      expect(handle.agent.promptCalls).toHaveLength(0);
    } finally {
      await bridge.shutdown();
    }
  });
});
