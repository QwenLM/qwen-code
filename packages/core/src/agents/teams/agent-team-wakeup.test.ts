/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_CONFIG_DIR } from '../../config/brand.js';
import { sendTeamMessage } from './agent-team-runtime.js';
import { getSessionTranscriptPath } from '../../services/transcript-paths.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import type { Config } from '../../config/config.js';
import {
  clearCommandQueue,
  getCommandQueueSnapshot,
} from '../../services/messageQueueManager.js';
import { _resetConfigHomeDirCache } from '../../utils/paths.js';
import { IN_PROCESS_TEAMMATE_TASK_TYPE } from './agent-teams-feature.js';
import {
  readAgentTeamConfig,
  upsertAgentTeamMember,
} from './agent-team-runtime.js';
import { wakeTeamMemberIfIdle } from './agent-team-wakeup.js';
import { runLocalAgentInvocation } from '../local-agent-runner.js';
import { AgentTerminateMode } from '../types.js';
import { readSubagentTranscript } from '../../services/subagent-transcript.js';

vi.mock('../local-agent-runner.js', () => ({
  runLocalAgentInvocation: vi.fn(async (params: {
    onTaskRegistered?: (task: {
      taskId: string;
      agentId: string;
      outputPath: string;
      transcriptPath: string;
    }) => void;
  }) => {
    params.onTaskRegistered?.({
      taskId: 'task-frontend',
      agentId: 'agent-frontend',
      outputPath: '/tmp/output',
      transcriptPath: '/tmp/transcript.jsonl',
    });
    return {
      taskId: 'task-frontend',
      agentId: 'agent-frontend',
      finalResult: 'Continued work.',
      terminateReason: AgentTerminateMode.GOAL,
      outputPath: '/tmp/output',
      totalTokens: 10,
      toolCalls: 1,
      durationMs: 20,
      teammateIdleSummary: '[to main] Continued work',
      toolResult: {
        llmContent: 'Continued work.',
        returnDisplay: 'Continued work.',
      },
    };
  }),
}));

vi.mock('../../services/subagent-transcript.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/subagent-transcript.js')>()),
  readSubagentTranscript: vi.fn(async () => null),
}));

const localDefinition = {
  kind: 'local',
  name: 'Reviewer',
  description: 'Review code',
  prompt: 'Review code',
  color: 'blue',
};

function makeContext(definition: unknown = localDefinition): AgentLoopContext {
  return {
    config: {
      getSessionId: () => 'leader-session',
      getProjectRoot: () => '/workspace/.qwen/worktrees/leader/apps',
      getSessionArtifactProjectRoot: () => '/workspace/apps',
      getActiveSessionTranscriptPath(this: Config): string {
        return getSessionTranscriptPath(this.getSessionArtifactProjectRoot(), this.getSessionId());
      },
      getActiveModel: () => 'ultimate',
      getModel: () => 'ultimate',
      getAgentRegistry: () => ({
        getDefinition: () => definition,
      }),
    } as unknown as Config,
  } as AgentLoopContext;
}

describe('agent-team-wakeup', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'test-agent-team-wakeup-'));
    vi.stubEnv(ENV_CONFIG_DIR, tempDir);
    _resetConfigHomeDirCache();
    vi.mocked(runLocalAgentInvocation).mockClear();
    vi.mocked(readSubagentTranscript).mockClear();
    clearCommandQueue();
  });

  afterEach(async () => {
    clearCommandQueue();
    vi.unstubAllEnvs();
    _resetConfigHomeDirCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resumes separate inbox businesses in separate executions', async () => {
    await upsertAgentTeamMember({
      teamName: 'session-abcdef12',
      leadSessionId: 'leader-session',
      member: {
        name: 'frontend',
        agentId: 'agent-frontend',
        taskId: 'task-frontend',
        agentType: 'Reviewer',
        resolvedModel: 'auto',
        sessionId: 'leader-session',
        status: 'idle',
      },
    });
    const businesses = [
      { version: '1', id: 'first-turn', model_key: 'auto' },
      { version: '1', id: 'second-turn', model_key: 'ultimate' },
    ];
    const contexts = [{ tenant: 'first' }, { tenant: 'second' }];
    for (const [index, businessInfo] of businesses.entries()) {
      await sendTeamMessage({
        teamName: 'session-abcdef12',
        from: 'team-lead',
        to: 'frontend',
        text: businessInfo.id,
        businessInfo,
        customContext: contexts[index],
      });
    }
    await wakeTeamMemberIfIdle({
      context: makeContext(),
      teamName: 'session-abcdef12',
      memberName: 'frontend',
      senderName: 'team-lead',
      message: 'continue',
      customContext: { tenant: 'caller' },
    });
    await vi.waitFor(() =>
      expect(runLocalAgentInvocation).toHaveBeenCalledTimes(2),
    );
    expect(
      vi
        .mocked(runLocalAgentInvocation)
        .mock.calls.map(([params]) => params.parentBusinessInfo),
    ).toEqual(businesses);
    expect(
      vi
        .mocked(runLocalAgentInvocation)
        .mock.calls.map(([params]) => params.customContext),
    ).toEqual(contexts);
    await vi.waitFor(async () =>
      expect(
        (await readAgentTeamConfig('session-abcdef12'))?.members.find(
          (member) => member.name === 'frontend',
        )?.status,
      ).toBe('idle'),
    );
  });

  it('starts one local teammate run after claiming an idle member', async () => {
    await upsertAgentTeamMember({
      teamName: 'session-abcdef12',
      leadSessionId: 'leader-session',
      member: {
        name: 'frontend',
        agentId: 'agent-frontend',
        taskId: 'task-frontend',
        agentType: 'Reviewer',
        resolvedModel: 'auto',
        sessionId: 'leader-session',
        status: 'idle',
        cwd: '/tmp/team-work',
      },
    });

    const result = await wakeTeamMemberIfIdle({
      context: makeContext(),
      teamName: 'session-abcdef12',
      memberName: 'frontend',
      senderName: 'team-lead',
      message: 'Please continue.',
      parentToolUseId: 'toolu-send-message',
      customContext: { tenant: 'wakeup' },
    });

    expect(result).toEqual({
      woken: true,
      agentId: 'agent-frontend',
      taskId: 'task-frontend',
      outputPath: '/tmp/output',
    });
    expect(runLocalAgentInvocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        definition: localDefinition,
        agentArgs: {
          query: expect.stringContaining('Please continue.'),
        },
        invocationName: 'frontend',
        teamName: 'session-abcdef12',
        cwdOverride: '/tmp/team-work',
        modelOverride: 'auto',
        parentToolUseId: 'toolu-send-message',
        customContext: { tenant: 'wakeup' },
        agentId: 'agent-frontend',
        resumeFromTranscript: true,
        taskType: IN_PROCESS_TEAMMATE_TASK_TYPE,
        emitSdkTaskNotification: false,
        preserveTaskOnTeammateIdle: true,
        onTaskRegistered: expect.any(Function),
      }));
    await vi.waitFor(async () => {
      expect(await readAgentTeamConfig('session-abcdef12')).toMatchObject({
        members: expect.arrayContaining([
          expect.objectContaining({
            name: 'frontend',
            status: 'idle',
          }),
        ]),
      });
    });
    expect(getCommandQueueSnapshot()).toEqual([
      expect.objectContaining({
        commandMode: 'prompt',
        origin: expect.objectContaining({
          kind: 'peer',
          from: 'frontend',
        }),
        prompt: expect.stringContaining(
          '"summary":"[to main] Continued work"',
        ),
      }),
    ]);
  });

  it('does not wake a teammate that is already running', async () => {
    await upsertAgentTeamMember({
      teamName: 'session-abcdef12',
      leadSessionId: 'leader-session',
      member: {
        name: 'frontend',
        agentId: 'agent-frontend',
        taskId: 'task-frontend',
        agentType: 'Reviewer',
        resolvedModel: 'auto',
        sessionId: 'leader-session',
        status: 'running',
      },
    });

    const result = await wakeTeamMemberIfIdle({
      context: makeContext(),
      teamName: 'session-abcdef12',
      memberName: 'frontend',
      senderName: 'team-lead',
      message: 'Please continue.',
    });

    expect(result).toEqual({
      woken: false,
      reason: 'already_running',
    });
    expect(runLocalAgentInvocation).not.toHaveBeenCalled();
  });

  it('does not wake a stopped teammate', async () => {
    await upsertAgentTeamMember({
      teamName: 'session-abcdef12',
      leadSessionId: 'leader-session',
      member: {
        name: 'frontend',
        agentId: 'agent-frontend',
        taskId: 'task-frontend',
        agentType: 'Reviewer',
        sessionId: 'leader-session',
        status: 'stopped',
      },
    });

    const result = await wakeTeamMemberIfIdle({
      context: makeContext(),
      teamName: 'session-abcdef12',
      memberName: 'frontend',
      senderName: 'team-lead',
      message: 'Please continue.',
      allowStaleRunning: true,
    });

    expect(result).toEqual({
      woken: false,
      reason: 'member_not_found',
    });
    expect(runLocalAgentInvocation).not.toHaveBeenCalled();
    expect(await readAgentTeamConfig('session-abcdef12')).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          name: 'frontend',
          status: 'stopped',
        }),
      ]),
    });
  });

  it('resumes a persisted running teammate when no local controller exists', async () => {
    await upsertAgentTeamMember({
      teamName: 'session-abcdef12',
      leadSessionId: 'leader-session',
      member: {
        name: 'frontend',
        agentId: 'agent-frontend',
        taskId: 'task-frontend',
        agentType: 'Reviewer',
        resolvedModel: 'auto',
        sessionId: 'leader-session',
        status: 'running',
      },
    });

    const result = await wakeTeamMemberIfIdle({
      context: makeContext(),
      teamName: 'session-abcdef12',
      memberName: 'frontend',
      senderName: 'team-lead',
      message: 'Continue after session resume.',
      allowStaleRunning: true,
    });

    expect(result.woken).toBe(true);
    expect(runLocalAgentInvocation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        agentId: 'agent-frontend',
        modelOverride: 'auto',
        resumeFromTranscript: true,
        preserveTaskOnTeammateIdle: true,
      }),
    );
    await vi.waitFor(async () => {
      expect(await readAgentTeamConfig('session-abcdef12')).toMatchObject({
        members: expect.arrayContaining([
          expect.objectContaining({
            name: 'frontend',
            status: 'idle',
          }),
        ]),
      });
    });
  });

  it('reads an idle teammate transcript from the source project in a worktree', async () => {
    await upsertAgentTeamMember({
      teamName: 'session-abcdef12',
      leadSessionId: 'leader-session',
      member: {
        name: 'frontend',
        agentId: 'agent-frontend',
        taskId: 'task-frontend',
        agentType: 'Reviewer',
        sessionId: 'leader-session',
        status: 'idle',
      },
    });

    await wakeTeamMemberIfIdle({
      context: makeContext(),
      teamName: 'session-abcdef12',
      memberName: 'frontend',
      senderName: 'team-lead',
      message: 'Please summarize the completed work.',
    });

    await vi.waitFor(() => {
      expect(readSubagentTranscript).toHaveBeenCalledWith(
        { sessionTranscriptPath: getSessionTranscriptPath('/workspace/apps', 'leader-session') },
        'leader-session',
        'agent-frontend',
      );
    });
  });
});
