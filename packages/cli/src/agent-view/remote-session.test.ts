/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentStatus } from '@qwen-code/qwen-code-core';
import { describe, expect, it, vi } from 'vitest';
import type { AgentViewSupervisorEvent } from './supervisor-client.js';
import { RemoteSession } from './remote-session.js';
import type { AgentViewSupervisorClientHandle } from './supervisor-runner.js';

describe('RemoteSession', () => {
  it('projects worker state and correlates leader prompts', async () => {
    let onEvent: ((event: AgentViewSupervisorEvent) => void) | undefined;
    const send = vi.fn().mockResolvedValue(undefined);
    const supervisor = {
      send,
      cancel: vi.fn(),
      stop: vi.fn(),
      subscribe: (listener: (event: AgentViewSupervisorEvent) => void) => {
        onEvent = listener;
        return { ready: Promise.resolve(), dispose: vi.fn() };
      },
    } as unknown as AgentViewSupervisorClientHandle;
    const session = new RemoteSession(
      'worker-1',
      'team-1',
      supervisor,
      '/workspace',
      'model-1',
    );

    onEvent?.({
      type: 'changed',
      at: new Date().toISOString(),
      sessionId: 'worker-1',
      workerEvent: {
        type: 'state',
        sessionId: 'worker-1',
        sessionState: 'working',
      },
    });
    onEvent?.({
      type: 'changed',
      at: new Date().toISOString(),
      sessionId: 'worker-1',
      workerEvent: {
        type: 'ready',
        sessionId: 'worker-1',
        cwd: '/workspace',
      },
    });
    await session.waitUntilReady(10);
    expect(session.getStatus()).toBe(AgentStatus.RUNNING);

    onEvent?.({
      type: 'changed',
      at: new Date().toISOString(),
      sessionId: 'worker-1',
      workerEvent: {
        type: 'viewSnapshot',
        sessionId: 'worker-1',
        snapshot: {
          messages: [
            { role: 'assistant', content: 'done', timestamp: Date.now() },
          ],
          pendingApprovals: [],
          liveOutputs: [],
          shellPids: [],
          executionStartTimes: [],
          workingDir: '/workspace',
          modelId: 'model-1',
        },
      },
    });
    expect(session.getMessages()[0]?.content).toBe('done');

    const turnId = await session.send('next');
    expect(send).toHaveBeenCalledWith('worker-1', turnId, 'next');
  });

  it('rejects startup when the worker exits before ready', async () => {
    let onEvent: ((event: AgentViewSupervisorEvent) => void) | undefined;
    const supervisor = {
      subscribe: (listener: (event: AgentViewSupervisorEvent) => void) => {
        onEvent = listener;
        return { ready: Promise.resolve(), dispose: vi.fn() };
      },
    } as unknown as AgentViewSupervisorClientHandle;
    const session = new RemoteSession(
      'worker-1',
      'team-1',
      supervisor,
      '/workspace',
      'model-1',
    );

    onEvent?.({
      type: 'changed',
      at: new Date().toISOString(),
      sessionId: 'worker-1',
      workerEvent: {
        type: 'state',
        sessionId: 'worker-1',
        sessionState: 'failed',
      },
    });

    await expect(session.waitUntilReady(10)).rejects.toThrow(
      'exited before becoming ready',
    );
  });
});
