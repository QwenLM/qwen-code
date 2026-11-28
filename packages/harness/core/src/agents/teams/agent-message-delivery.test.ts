/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import type { Config } from '../../config/config.js';
import { wrapTextByOrigin } from '../../input/origin-content-wrapping.js';
import { TaskRegistry } from '../../tasks/task-registry.js';
import type { AgentUnifiedTask } from '../../tasks/unified-task.js';
import { resumeBackgroundAgentWithMessage } from './agent-message-delivery.js';
import { runLocalAgentInvocation } from '../local-agent-runner.js';

vi.mock('../local-agent-runner.js', () => ({
  runLocalAgentInvocation: vi.fn(),
}));

function makeRecipient(): AgentUnifiedTask {
  return {
    id: 'a-agent-reviewer',
    type: 'local_agent',
    status: 'completed',
    description: 'Review the implementation',
    startTime: Date.now(),
    notified: true,
    executionId: 1001,
    completionBehavior: 'notify',
    agentId: 'agent-reviewer',
    agentName: 'reviewer',
    agentType: 'Reviewer',
    resolvedModel: 'auto',
    prompt: 'Review the implementation',
    isBackgrounded: true,
    taskId: 'agent-reviewer',
    outputPath: '/tmp/agent-reviewer.output',
    worktreePath: '/tmp/reviewer-worktree',
  };
}

describe('resumeBackgroundAgentWithMessage', () => {
  beforeEach(() => {
    vi.mocked(runLocalAgentInvocation).mockReset();
    vi.mocked(runLocalAgentInvocation).mockImplementation(async (params) => {
      params.onTaskRegistered?.({
        agentId: 'agent-reviewer',
        taskId: 'agent-reviewer',
        outputPath: '/tmp/agent-reviewer.output',
        transcriptPath: '/tmp/agent-reviewer.jsonl',
      });
      return new Promise(() => {});
    });
  });

  it('resumes the same transcript, worktree, and saved model after the parent switches', async () => {
    const taskRegistry = new TaskRegistry();
    const config = {
      getSessionId: () => 'session-root',
      getAgentRegistry: () => ({
        getDefinition: () => ({
          kind: 'local',
          name: 'Reviewer',
        }),
      }),
      getActiveModel: () => 'ultimate',
      getModel: () => 'ultimate',
    } as unknown as Config;
    const context = {
      config,
      taskRegistry,
    } as AgentLoopContext;

    await resumeBackgroundAgentWithMessage({
      context,
      recipient: makeRecipient(),
      message: 'Review the latest changes.',
      origin: { kind: 'coordinator' },
      parentToolUseId: 'toolu-send-message',
      customContext: { tenant: 'resume' },
    });

    expect(runLocalAgentInvocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: 'agent-reviewer',
        resumeFromTranscript: true,
        cwdOverride: '/tmp/reviewer-worktree',
        modelOverride: 'auto',
        agentArgs: {
          query: wrapTextByOrigin('Review the latest changes.', {
            kind: 'coordinator',
          }),
        },
        customContext: { tenant: 'resume' },
      }),
    );
  });
});
