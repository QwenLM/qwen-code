/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentViewActivityFile,
  AgentViewSessionStateFile,
} from './protocol.js';
import { deriveAgentViewPresentation } from './presentation.js';

describe('deriveAgentViewPresentation', () => {
  it('maps running sessions to the Working group', () => {
    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'working' }),
        now: '2026-07-17T10:00:00.000Z',
      }),
    ).toMatchObject({
      taskState: 'running',
      group: 'working',
      iconShape: 'alive',
      iconTone: 'working',
      actions: {
        canReply: false,
        canStop: true,
      },
    });
  });

  it('distinguishes blocking needs input from soft questions', () => {
    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'needs_input' }),
        activity: activity({ waitingFor: 'approval', inputKind: 'blocking' }),
      }),
    ).toMatchObject({
      taskState: 'waiting',
      inputState: 'permission',
      group: 'needs_input',
      actions: {
        canReply: false,
        canHibernate: false,
        needsBlockingAnswer: true,
      },
    });

    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'needs_input' }),
        activity: activity({ waitingFor: 'response' }),
      }),
    ).toMatchObject({
      taskState: 'waiting',
      inputState: 'soft_question',
      actions: {
        canReply: true,
        canHibernate: true,
        needsBlockingAnswer: false,
      },
    });

    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'needs_input' }),
        activity: activity({ waitingFor: 'question', inputKind: 'soft' }),
      }),
    ).toMatchObject({
      taskState: 'waiting',
      inputState: 'soft_question',
      group: 'needs_input',
      actions: {
        canReply: true,
        canHibernate: true,
        needsBlockingAnswer: false,
      },
    });
  });

  it('classifies settings confirmations as auth or settings input', () => {
    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'needs_input' }),
        activity: activity({
          waitingFor: 'setting_confirmation',
          inputKind: 'blocking',
        }),
      }),
    ).toMatchObject({
      inputState: 'auth_or_settings',
      group: 'needs_input',
    });
  });

  it('keeps ready, stopped, and failed sessions in the Completed group', () => {
    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'completed' }),
        activity: activity({ lastResult: 'Done' }),
      }),
    ).toMatchObject({
      taskState: 'ready',
      group: 'completed',
      iconTone: 'ready',
      subtitle: 'Done',
      actions: { canReply: true },
    });

    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'stopped', processState: 'exited' }),
      }),
    ).toMatchObject({
      taskState: 'stopped',
      group: 'completed',
      recoverability: 'restartable',
      iconShape: 'exited',
      iconTone: 'stopped',
      subtitle: 'Stopped by user',
      actions: {
        canAttach: true,
        canReply: true,
        canRespawn: true,
      },
    });

    expect(
      deriveAgentViewPresentation({
        state: session({ sessionState: 'failed', processState: 'exited' }),
      }),
    ).toMatchObject({
      taskState: 'failed',
      group: 'completed',
      recoverability: 'restartable',
      iconShape: 'exited',
      iconTone: 'failed',
      subtitle: 'Session failed',
      actions: {
        canAttach: true,
        canReply: true,
        canRespawn: true,
      },
    });
  });
});

function session(
  overrides: Partial<AgentViewSessionStateFile> = {},
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    ownership: 'managed',
    sessionState: 'idle',
    processState: 'alive',
    attachState: 'detached',
    projectCwd: '/workspace/qwen-code',
    originalCwd: '/workspace/qwen-code',
    activeCwd: '/workspace/qwen-code',
    createdAt: '2026-07-17T09:00:00.000Z',
    updatedAt: '2026-07-17T09:00:00.000Z',
    worktree: { mode: 'none' },
    ...overrides,
  };
}

function activity(
  overrides: Partial<AgentViewActivityFile> = {},
): AgentViewActivityFile {
  return {
    schemaVersion: 1,
    lastActivityAt: '2026-07-17T09:00:00.000Z',
    capabilities: [],
    ...overrides,
  };
}
