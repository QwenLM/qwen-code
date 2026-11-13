/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeBridge, makeChannel, WS_A } from './internal/testUtils.js';
import { SERVE_STATUS_EXT_METHODS } from './status.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('active session paged replay', () => {
  it.each(['foreground', 'background'] as const)(
    'serves concurrent loads from memory without transcript reads during a %s turn',
    async (kind) => {
      const promptGate = deferred<void>();
      const handle = makeChannel({
        promptImpl: async () => {
          await promptGate.promise;
          return { stopReason: 'end_turn' };
        },
        extMethodImpl: () => ({ v: 1, events: [], hasMore: false }),
      });
      const bridge = makeBridge({ channelFactory: async () => handle.channel });
      let prompt: Promise<unknown> | undefined;
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        if (kind === 'foreground') {
          prompt = bridge.sendPrompt(session.sessionId, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'keep the turn active' }],
          });
          await vi.waitFor(() =>
            expect(handle.agent.promptCalls).toHaveLength(1),
          );
        } else {
          await expect(
            handle.agentConnection.extMethod('_qwencode/start_turn', {
              sessionId: session.sessionId,
              source: 'background_notification',
              turnId: 'notification-1',
              taskId: 'agent-1',
              kind: 'agent',
              sourceTurnId: 'user-1',
              toolUseId: 'call-1',
              label: 'Agent',
              startedAt: 1000,
            }),
          ).resolves.toMatchObject({ accepted: true });
        }
        await handle.agentConnection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'live response' },
          },
        });

        const request = {
          sessionId: session.sessionId,
          workspaceCwd: WS_A,
          clientId: session.clientId,
          historyReplay: 'response' as const,
          liveReplayMode: 'summary' as const,
          historyPageSize: 100,
        };
        const results = await Promise.all([
          bridge.loadSession(request),
          bridge.loadSession(request),
        ]);

        expect(
          handle.agent.extMethodCalls.filter(
            (call) =>
              call.method === SERVE_STATUS_EXT_METHODS.sessionTranscript,
          ),
        ).toHaveLength(0);
        for (const result of results) {
          expect(JSON.stringify(result.liveJournal)).toContain('live response');
          expect(result.eventEpoch).toBeDefined();
          expect(result.lastEventId).toBeDefined();
        }
      } finally {
        promptGate.resolve();
        await prompt;
        await bridge.shutdown();
      }
    },
  );

  it.each([
    { kind: 'foreground', emptyPage: false },
    { kind: 'background', emptyPage: false },
    { kind: 'foreground', emptyPage: true },
    { kind: 'background', emptyPage: true },
  ] as const)(
    'stops reading when a $kind turn starts during a transcript read (empty page: $emptyPage)',
    async ({ kind, emptyPage }) => {
      const promptGate = deferred<void>();
      const pageGate = deferred<Record<string, unknown>>();
      let transcriptReads = 0;
      const persistedPage = {
        v: 1,
        events: [
          {
            v: 1,
            type: 'session_update',
            data: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'stale persisted response' },
            },
          },
        ],
        hasMore: false,
      };
      const handle = makeChannel({
        promptImpl: async () => {
          await promptGate.promise;
          return { stopReason: 'end_turn' };
        },
        extMethodImpl: async (method) => {
          if (method !== SERVE_STATUS_EXT_METHODS.sessionTranscript) return {};
          return ++transcriptReads === 1 ? pageGate.promise : persistedPage;
        },
      });
      const bridge = makeBridge({ channelFactory: async () => handle.channel });
      let prompt: Promise<unknown> | undefined;
      try {
        const session = await bridge.spawnOrAttach({ workspaceCwd: WS_A });
        const load = bridge.loadSession({
          sessionId: session.sessionId,
          workspaceCwd: WS_A,
          clientId: session.clientId,
          historyReplay: 'response',
          liveReplayMode: 'summary',
          historyPageSize: 100,
        });
        await vi.waitFor(() => expect(transcriptReads).toBe(1));
        if (kind === 'foreground') {
          prompt = bridge.sendPrompt(session.sessionId, {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: 'a new turn' }],
          });
          await vi.waitFor(() =>
            expect(handle.agent.promptCalls).toHaveLength(1),
          );
        } else {
          await expect(
            handle.agentConnection.extMethod('_qwencode/start_turn', {
              sessionId: session.sessionId,
              source: 'background_notification',
              turnId: 'notification-1',
              taskId: 'agent-1',
              kind: 'agent',
              sourceTurnId: 'user-1',
              toolUseId: 'call-1',
              label: 'Agent',
              startedAt: 1000,
            }),
          ).resolves.toMatchObject({ accepted: true });
        }
        await handle.agentConnection.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'new live response' },
          },
        });
        pageGate.resolve(
          emptyPage
            ? { v: 1, events: [], hasMore: true, nextCursor: 'older' }
            : persistedPage,
        );

        const result = await load;
        expect(transcriptReads).toBe(1);
        expect(JSON.stringify(result.liveJournal)).toContain(
          'new live response',
        );
        expect(JSON.stringify(result)).not.toContain(
          'stale persisted response',
        );
      } finally {
        pageGate.resolve(persistedPage);
        promptGate.resolve();
        await prompt;
        await bridge.shutdown();
      }
    },
  );
});
