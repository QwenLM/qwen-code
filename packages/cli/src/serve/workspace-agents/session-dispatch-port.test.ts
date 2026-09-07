/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceAgent } from '@qwen-code/qwen-code-core';

import {
  createSessionDispatchPort,
  type AgentSessionBridge,
} from './session-dispatch-port.js';

const WS = '/ws';
const AGENT: WorkspaceAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };

const TURN = {
  workspaceId: 'ws_1',
  threadId: 'th_1',
  rootThreadId: 'th_1',
  runId: 'run_1',
  attempt: 1,
  contextThroughSequence: 4,
};

function makeBridge(sessions: unknown[] = []) {
  const sendPrompt = vi.fn().mockResolvedValue({});
  const bridge = {
    spawnOrAttach: vi.fn().mockResolvedValue({ sessionId: 'agent-ag_alice' }),
    sendPrompt,
    listWorkspaceSessions: vi.fn().mockReturnValue(sessions),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    getSessionStatsStatus: vi.fn().mockResolvedValue({ models: {} }),
  } as unknown as AgentSessionBridge;
  return { bridge, sendPrompt };
}

/** The trusted context of the one prompt the bridge was asked to send. */
function contextOf(sendPrompt: ReturnType<typeof vi.fn>) {
  return sendPrompt.mock.calls[0]?.[3];
}

describe('session dispatch port', () => {
  it('tells the agent which run its opening turn belongs to', async () => {
    // Without this the child boots with the right persona and then throws on
    // its first thread tool, because nothing else carries the run identity
    // across the process boundary.
    const { bridge, sendPrompt } = makeBridge();
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    const result = await port.start({
      action: 'launch',
      agent: AGENT,
      prompt: 'envelope',
      ...TURN,
    });

    expect(result.status).toBe('started');
    expect(contextOf(sendPrompt)?.agentRun).toEqual({
      workspaceId: 'ws_1',
      agentId: 'ag_alice',
      runId: 'run_1',
      threadId: 'th_1',
      rootThreadId: 'th_1',
      attempt: 1,
      contextThroughSequence: 4,
    });
  });

  it('carries the same run on a mid-run delivery', async () => {
    // A message arriving while the agent works is another turn of the same
    // run. Sent without a frame it would be readable and unanswerable.
    const { bridge, sendPrompt } = makeBridge([
      {
        sessionId: 'agent-ag_alice',
        sourceType: 'agent',
        sourceId: 'ag_alice',
      },
    ]);
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    const delivered = await port.deliver?.({
      agent: AGENT,
      prompt: 'a peer replied',
      deliveryId: 'msg_9',
      ...TURN,
    });

    expect(delivered).toBe(true);
    expect(contextOf(sendPrompt)?.agentRun).toMatchObject({
      agentId: 'ag_alice',
      runId: 'run_1',
      threadId: 'th_1',
    });
  });

  it('finds the body by source, not by the session id convention', async () => {
    // The id is a convention; the source attribution is the record.
    const { bridge } = makeBridge([
      {
        sessionId: 'something-else',
        sourceType: 'agent',
        sourceId: 'ag_alice',
      },
    ]);
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    await expect(port.inspect(AGENT)).resolves.toEqual({ kind: 'completed' });
  });

  it('reports an agent with no session as absent', async () => {
    const { bridge } = makeBridge([
      { sessionId: 'x', sourceType: 'agent', sourceId: 'ag_someone_else' },
    ]);
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    await expect(port.inspect(AGENT)).resolves.toEqual({ kind: 'absent' });
  });

  it('does not deliver to an agent whose session is gone', async () => {
    const { bridge, sendPrompt } = makeBridge();
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    const delivered = await port.deliver?.({
      agent: AGENT,
      prompt: 'text',
      deliveryId: 'msg_1',
      ...TURN,
    });

    expect(delivered).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('reports a persona failure as unavailable, not as a crash', async () => {
    // The child refuses rather than booting a generic assistant under this
    // agent's name; that is a configuration error the dispatcher must not
    // record as a failed launch.
    const { bridge } = makeBridge();
    (bridge.spawnOrAttach as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No agent "ag_alice" in this workspace\'s roster.'),
    );
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    const result = await port.start({
      action: 'launch',
      agent: AGENT,
      prompt: 'envelope',
      ...TURN,
    });

    expect(result.status).toBe('agent_unavailable');
  });
});
