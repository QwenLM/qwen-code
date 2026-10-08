/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { A2ASessionError } from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-server.js';
import {
  createA2ASessionPort,
  type A2AOrchestrator,
  type A2ASessionBridge,
  type A2ATranscriptRecord,
} from './a2a-sessions.js';
import { SessionAgentError } from './orchestrator.js';

const SESSION = '11111111-2222-4333-8444-555555555555';

function setup(
  options: {
    orchestrator?: Partial<A2AOrchestrator> | null;
    records?: A2ATranscriptRecord[];
  } = {},
) {
  const bridge = {
    spawnOrAttach: vi.fn(async () => ({
      sessionId: SESSION,
      workspaceCwd: '/ws',
      attached: false,
    })),
    updateSessionMetadata: vi.fn(() => ({})),
  };
  const orchestrator =
    options.orchestrator === null
      ? undefined
      : ({
          bridge,
          mention: vi.fn(async () => ({
            recordId: 'rec_1',
            runs: [{ runId: 'sr_1', agentId: 'ag_lead', status: 'queued' }],
          })),
          snapshot: vi.fn(async () => []),
          cancel: vi.fn(async () => true),
          ...options.orchestrator,
        } as unknown as A2AOrchestrator);
  const port = createA2ASessionPort({
    workspaceCwd: '/ws',
    bridge: bridge as unknown as A2ASessionBridge,
    orchestrator,
    loadRecords: async () => options.records,
  });
  return { bridge, orchestrator, port };
}

describe('A2A session port', () => {
  it('creates a listed chat session attributed to the caller', async () => {
    const { bridge, port } = setup();

    await expect(
      port.createSession({
        callerId: 'share_1',
        agentId: 'ag_lead',
        title: 'A2A · share_1',
      }),
    ).resolves.toBe(SESSION);
    expect(bridge.spawnOrAttach).toHaveBeenCalledWith({
      workspaceCwd: '/ws',
      sessionScope: 'thread',
      // `default`, so WebShell lists it and the owner can answer approvals.
      sourceType: 'default',
      sourceId: 'a2a:share_1',
    });
    expect(bridge.updateSessionMetadata).toHaveBeenCalledWith(SESSION, {
      displayName: 'A2A · share_1',
      titleSource: 'auto',
    });
  });

  it('is unavailable without the workspace orchestrator', async () => {
    const missing = setup({ orchestrator: null });
    await expect(
      missing.port.createSession({
        callerId: 'share_1',
        agentId: 'ag_lead',
        title: 't',
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(missing.bridge.spawnOrAttach).not.toHaveBeenCalled();

    // One left over from a replaced bridge is not this runtime's.
    const stale = setup({ orchestrator: { bridge: {} as never } });
    await expect(
      stale.port.mention(SESSION, { text: '@lead hi', clientMessageId: 'a' }),
    ).rejects.toBeInstanceOf(A2ASessionError);
    await expect(stale.port.cancel(SESSION, 'sr_1')).rejects.toMatchObject({
      kind: 'unavailable',
    });
    await expect(stale.port.liveRun(SESSION, 'sr_1')).resolves.toBeUndefined();
  });

  it('maps orchestrator refusals', async () => {
    const refused = setup({
      orchestrator: {
        mention: vi.fn(async () => {
          throw new SessionAgentError(400, 'no_agents_mentioned', 'none');
        }),
      },
    });
    await expect(
      refused.port.mention(SESSION, { text: 'x', clientMessageId: 'a' }),
    ).rejects.toMatchObject({ kind: 'refused' });

    const stopping = setup({
      orchestrator: {
        mention: vi.fn(async () => {
          throw new SessionAgentError(503, 'orchestrator_stopped', 'stop');
        }),
      },
    });
    await expect(
      stopping.port.mention(SESSION, { text: 'x', clientMessageId: 'a' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    const broken = setup({
      orchestrator: {
        mention: vi.fn(async () => {
          throw new SessionAgentError(502, 'record_write_failed', 'io');
        }),
      },
    });
    await expect(
      broken.port.mention(SESSION, { text: 'x', clientMessageId: 'a' }),
    ).rejects.toBeInstanceOf(SessionAgentError);
  });

  it('reads live runs from the snapshot and replies from the transcript', async () => {
    const { port } = setup({
      orchestrator: {
        snapshot: vi.fn(async () => [
          {
            type: 'run' as const,
            sessionId: SESSION,
            runId: 'sr_1',
            author: { agentId: 'ag_lead', name: 'lead' },
            status: 'awaiting_approval' as const,
            activityAt: 5,
          },
        ]),
      },
      records: [
        {
          subtype: 'agent_message',
          timestamp: '2026-10-06T00:00:00.000Z',
          systemPayload: {
            displayText: 'Done.',
            author: { agentId: 'ag_lead', name: 'lead' },
            runId: 'sr_2',
            status: 'completed',
          },
        },
      ],
    });

    await expect(port.liveRun(SESSION, 'sr_1')).resolves.toEqual({
      status: 'awaiting_approval',
      activityAt: 5,
    });
    await expect(port.liveRun(SESSION, 'sr_2')).resolves.toBeUndefined();
    await expect(port.recordedReply(SESSION, 'sr_2')).resolves.toEqual({
      at: Date.parse('2026-10-06T00:00:00.000Z'),
      payload: expect.objectContaining({ displayText: 'Done.' }),
    });
    await expect(port.recordedReply(SESSION, 'sr_1')).resolves.toBeUndefined();
  });
});
