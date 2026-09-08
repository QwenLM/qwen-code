/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceAgent } from '@qwen-code/qwen-code-core';
import { agentThreadSessionId } from '../../runtime/agent-session-source.js';

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
    spawnOrAttach: vi
      .fn()
      .mockImplementation(async (input: { sessionId: string }) => ({
        sessionId: input.sessionId,
      })),
    resumeSession: vi
      .fn()
      .mockImplementation(async (input: { sessionId: string }) => ({
        sessionId: input.sessionId,
      })),
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
  it('uses stable RFC UUID session IDs accepted by ACP', () => {
    const id = agentThreadSessionId(AGENT.id, TURN.threadId);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(agentThreadSessionId(AGENT.id, TURN.threadId)).toBe(id);
    expect(agentThreadSessionId(AGENT.id, 'th_2')).not.toBe(id);
    expect(agentThreadSessionId('ag_bob', TURN.threadId)).not.toBe(id);
  });
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
    expect(sendPrompt).not.toHaveBeenCalled();
    if (result.status !== 'started')
      throw new Error('Expected prepared session');
    expect(result.consumedOnStart).toBe(false);
    result.activate?.();
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

  it('leaves mid-run replies for durable rebooking instead of another prompt', async () => {
    const { bridge, sendPrompt } = makeBridge([
      {
        sessionId: agentThreadSessionId(AGENT.id, TURN.threadId),
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

    expect(delivered).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('returns before the model settles and exposes the owning run and failure', async () => {
    const { bridge, sendPrompt } = makeBridge();
    let reject!: (error: Error) => void;
    sendPrompt.mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });
    const result = await port.start({
      action: 'launch',
      agent: AGENT,
      prompt: 'work',
      ...TURN,
    });
    if (result.status !== 'started')
      throw new Error('Expected prepared session');
    result.activate?.();
    await expect(
      port.inspect({ agent: AGENT, threadId: TURN.threadId }),
    ).resolves.toEqual({
      kind: 'running',
      threadId: TURN.threadId,
      runId: TURN.runId,
      attempt: TURN.attempt,
    });
    reject(new Error('Model connection lost'));
    await vi.waitFor(async () => {
      expect(
        await port.inspect({ agent: AGENT, threadId: TURN.threadId }),
      ).toEqual({
        kind: 'failed',
        runId: TURN.runId,
        attempt: TURN.attempt,
        error: 'Model connection lost',
      });
    });
  });

  it('does not reuse the same agent session from another thread', async () => {
    const { bridge } = makeBridge([
      {
        sessionId: agentThreadSessionId(AGENT.id, 'th_other'),
        sourceType: 'agent',
        sourceId: 'ag_alice',
      },
    ]);
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    await expect(
      port.inspect({ agent: AGENT, threadId: TURN.threadId }),
    ).resolves.toEqual({ kind: 'absent' });
  });

  it('reports an agent with no session as absent', async () => {
    const { bridge } = makeBridge([
      { sessionId: 'x', sourceType: 'agent', sourceId: 'ag_someone_else' },
    ]);
    const port = createSessionDispatchPort({ bridge, workspaceCwd: WS });

    await expect(
      port.inspect({ agent: AGENT, threadId: TURN.threadId }),
    ).resolves.toEqual({ kind: 'absent' });
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
