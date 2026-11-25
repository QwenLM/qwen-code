/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AgentUnifiedTask } from '@qwen-code/core';
import { StreamingState } from '../types.js';
import { buildBackgroundAgentWaitingItem } from './backgroundAgentWaiting.js';

function makeAgent(
  id: string,
  overrides: Partial<AgentUnifiedTask> = {},
): AgentUnifiedTask {
  return {
    id: `agent-${id}`,
    type: 'local_agent',
    status: 'running',
    description: `Inspect ${id}`,
    startTime: Date.now(),
    notified: false,
    executionId: 1,
    completionBehavior: 'notify',
    agentId: id,
    agentType: 'general-purpose',
    agentName: 'general-purpose',
    prompt: `Inspect ${id}`,
    isBackgrounded: true,
    taskId: id,
    inProgressToolUseIds: [],
    ...overrides,
  };
}

describe('buildBackgroundAgentWaitingItem', () => {
  it('builds a singular live marker for one running background agent', () => {
    expect(
      buildBackgroundAgentWaitingItem({
        tasks: [makeAgent('one')],
        streamingState: StreamingState.Idle,
      }),
    ).toMatchObject({
      type: 'info',
      text: 'Waiting for 1 background agent to finish',
      activity: true,
    });
  });

  it('uses plural wording for multiple running background agents', () => {
    expect(
      buildBackgroundAgentWaitingItem({
        tasks: [makeAgent('one'), makeAgent('two')],
        streamingState: StreamingState.Idle,
      }),
    ).toMatchObject({
      text: 'Waiting for 2 background agents to finish',
    });
  });

  it('does not render while the main agent is responding', () => {
    expect(
      buildBackgroundAgentWaitingItem({
        tasks: [makeAgent('one')],
        streamingState: StreamingState.Responding,
      }),
    ).toBeNull();
  });

  it('ignores completed and foreground agents', () => {
    expect(
      buildBackgroundAgentWaitingItem({
        tasks: [
          makeAgent('completed', { status: 'completed' }),
          makeAgent('foreground', { isBackgrounded: false }),
        ],
        streamingState: StreamingState.Idle,
      }),
    ).toBeNull();
  });

  it('ignores long-lived teammates', () => {
    expect(
      buildBackgroundAgentWaitingItem({
        tasks: [
          makeAgent('researcher', {
            type: 'in_process_teammate',
            agentName: 'researcher',
            isIdle: true,
          }),
        ],
        streamingState: StreamingState.Idle,
      }),
    ).toBeNull();
  });
});
