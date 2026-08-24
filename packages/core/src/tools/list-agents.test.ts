/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Config } from '../config/config.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import { ListAgentsTool } from './list-agents.js';

const peerMocks = vi.hoisted(() => ({
  getOwnPeerIdentity: vi.fn(),
  listMessageablePeers: vi.fn(),
}));

vi.mock('../ipc/peer-send.js', () => ({
  getOwnPeerIdentity: peerMocks.getOwnPeerIdentity,
}));
vi.mock('../ipc/peer-directory.js', async () => {
  const real = await vi.importActual<typeof import('../ipc/peer-directory.js')>(
    '../ipc/peer-directory.js',
  );
  return { ...real, listMessageablePeers: peerMocks.listMessageablePeers };
});

const peerAddress = (
  sessionId: string,
  ipcPath: string,
  pid: number,
  procStart: string,
  startedAt: number,
) =>
  `qwen-session:${createHash('sha256')
    .update(sessionId)
    .update('\0')
    .update(ipcPath)
    .update('\0')
    .update(String(pid))
    .update('\0')
    .update(procStart)
    .update('\0')
    .update(String(startedAt))
    .digest('hex')}`;

describe('ListAgentsTool', () => {
  let registry: BackgroundTaskRegistry;
  let tool: ListAgentsTool;
  let crossSessionMessagingEnabled: boolean;

  beforeEach(() => {
    peerMocks.getOwnPeerIdentity.mockReset().mockResolvedValue(null);
    peerMocks.listMessageablePeers.mockReset().mockResolvedValue([]);
    registry = new BackgroundTaskRegistry();
    crossSessionMessagingEnabled = false;
    tool = new ListAgentsTool({
      getBackgroundTaskRegistry: () => registry,
      isCrossSessionMessagingEnabled: () => crossSessionMessagingEnabled,
    } as unknown as Config);
  });

  it('reports an empty roster', async () => {
    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(tool.name).toBe('list_agents');
    expect(result.llmContent).toBe(
      'No ordinary background subagents are available in this session. ' +
        'Named Agent Team teammates are not listed here; their results are ' +
        'delivered automatically through team messaging, so do not use ' +
        'list_agents to wait for a teammate.',
    );
  });

  it('states the Agent Team boundary in the tool description', () => {
    expect(tool.description).toContain(
      'Named Agent Team teammates are NOT listed here',
    );
    expect(tool.description).toContain(
      'deliver their final reports automatically',
    );
    expect(tool.description).toContain(
      'do not use list_agents (or poll task_list) to wait for a teammate',
    );
  });

  it('lists only background agents with stable continuation fields', async () => {
    registry.register({
      agentId: 'agent-running',
      subagentType: 'explore',
      description: 'Inspect runtime',
      isBackgrounded: true,
      status: 'running',
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-running.jsonl',
    });
    registry.register({
      agentId: 'agent-foreground',
      description: 'Inline work',
      isBackgrounded: false,
      status: 'running',
      startTime: 2,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-foreground.jsonl',
    });
    registry.register({
      agentId: 'agent-blocked',
      description: 'Unsafe restore',
      isBackgrounded: true,
      status: 'completed',
      startTime: 3,
      endTime: 4,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-blocked.jsonl',
      resumeBlockedReason: 'Transcript does not match.',
    });

    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.llmContent))).toEqual({
      agents: [
        {
          task_id: 'agent-running',
          subagent_type: 'explore',
          description: 'Inspect runtime',
          status: 'running',
          can_message: true,
        },
        {
          task_id: 'agent-blocked',
          description: 'Unsafe restore',
          status: 'completed',
          can_message: false,
          resume_blocked_reason: 'Transcript does not match.',
        },
      ],
    });
  });

  it('lists reachable peer sessions with unambiguous addresses', async () => {
    crossSessionMessagingEnabled = true;
    registry.register({
      agentId: 'agent-running',
      description: 'Inspect runtime',
      isBackgrounded: true,
      status: 'running',
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-running.jsonl',
    });
    peerMocks.getOwnPeerIdentity.mockResolvedValue({
      sessionId: 'self',
      ipcPath: '/tmp/self.sock',
      name: 'self',
      address: peerAddress('self', '/tmp/self.sock', 1, 'process-1', 0),
    });
    peerMocks.listMessageablePeers.mockResolvedValue([
      {
        sessionId: 'self',
        name: 'self',
        ref: '000000',
        cwd: '/work/self',
        pid: 1,
        procStart: 'process-1',
        ipcPath: '/tmp/self.sock',
        startedAt: 0,
      },
      {
        sessionId: 'peer-a',
        name: 'app',
        ref: 'aaaaaa',
        cwd: '/work/a',
        pid: 2,
        procStart: 'process-2',
        ipcPath: '/tmp/a.sock',
        startedAt: 1,
      },
      {
        sessionId: 'peer-b',
        name: 'app',
        ref: 'bbbbbb',
        cwd: '/work/b',
        pid: 3,
        procStart: 'process-3',
        ipcPath: '/tmp/b.sock',
        startedAt: 2,
      },
    ]);

    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.llmContent))).toEqual({
      agents: [
        {
          task_id: 'agent-running',
          description: 'Inspect runtime',
          status: 'running',
          can_message: true,
        },
      ],
      sessions: [
        {
          to: peerAddress('peer-a', '/tmp/a.sock', 2, 'process-2', 1),
          name: 'app',
          ref: 'aaaaaa',
          cwd: '/work/a',
          started_at: '1970-01-01T00:00:00.001Z',
        },
        {
          to: peerAddress('peer-b', '/tmp/b.sock', 3, 'process-3', 2),
          name: 'app',
          ref: 'bbbbbb',
          cwd: '/work/b',
          started_at: '1970-01-01T00:00:00.002Z',
        },
      ],
    });
  });

  it('does not inspect the peer registry when the experiment is off', async () => {
    await tool.validateBuildAndExecute({}, new AbortController().signal);

    expect(peerMocks.getOwnPeerIdentity).not.toHaveBeenCalled();
    expect(peerMocks.listMessageablePeers).not.toHaveBeenCalled();
  });
});
