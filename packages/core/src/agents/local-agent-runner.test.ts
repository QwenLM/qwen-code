/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getSessionTranscriptPath } from '../services/transcript-paths.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import { ENV_ENABLE_AGENT_SESSIONS } from '../config/brand.js';
import {
  getSubagentTranscriptPath,
  readSubagentTranscript,
} from '../services/subagent-transcript.js';
import { registerAgentTask } from './agent-task-runtime.js';
import { TaskRegistry } from '../tasks/task-registry.js';
import { runLocalAgentInvocation } from './local-agent-runner.js';
import { resolveAgentModel, runAgent } from './run-agent.js';
import { AgentTerminateMode, type LocalAgentDefinition } from './types.js';

vi.mock('../services/executionLifecycleService.js', () => ({
  ExecutionLifecycleService: {
    createExecution: vi.fn(() => ({ pid: 'execution-1' })),
    appendOutput: vi.fn(),
    completeExecution: vi.fn(),
  },
}));

vi.mock('../services/subagent-transcript.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../services/subagent-transcript.js')
  >()),
  getSubagentTranscriptPath: vi.fn(() => '/tmp/subagents/agent-agent-1.jsonl'),
  readSubagentTranscript: vi.fn(async () => null),
}));

vi.mock('../utils/task/diskOutput.js', () => ({
  initTaskOutputAsSymlink: vi.fn(async () => '/tmp/task-output'),
  flushTaskOutput: vi.fn(async () => undefined),
}));

vi.mock('./agent-task-runtime.js', () => ({
  registerAgentTask: vi.fn(async () => undefined),
}));

vi.mock('./run-agent.js', () => ({
  resolveAgentModel: vi.fn(() => 'auto'),
  runAgent: vi.fn(async () => ({
    taskId: 'task-1',
    agentId: 'agent-1',
    finalResult: 'done',
    terminateReason: 'GOAL',
    toolResult: { llmContent: 'done' },
  })),
  toAgentResumeState: vi.fn((transcript) =>
    transcript
      ? {
          messages: transcript.messages,
          transcriptLeafUuid: transcript.leafUuid,
        }
      : undefined,
  ),
}));

vi.mock('../utils/agentId.js', () => ({
  createAgentId: vi.fn(() => 'task-1'),
}));

function definition(): LocalAgentDefinition {
  return {
    kind: 'local',
    name: 'Explore',
    description: 'Inspect the repository',
    inputConfig: {
      inputSchema: { type: 'object', properties: {} },
    },
    modelConfig: { model: 'test-model', generateContentConfig: {} },
    runConfig: { maxTimeMinutes: 1 },
    promptConfig: { systemPrompt: 'Inspect the repository.' },
  };
}

function context(
  taskRegistry?: AgentLoopContext['taskRegistry'],
): AgentLoopContext {
  return {
    config: {
      getSessionPersistence: () => true,
      getProjectRoot: () => '/workspace/project',
      getSessionArtifactProjectRoot: () => '/workspace/project',
      getActiveSessionTranscriptPath(): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => 'session-1',
      getTargetDir: () => '/workspace/project',
    },
    toolRegistry: {
      getTool: vi.fn(() => undefined),
    },
    taskRegistry,
  } as unknown as AgentLoopContext;
}

function worktreeContext(): AgentLoopContext {
  return {
    config: {
      getSessionPersistence: () => true,
      getProjectRoot: () => '/workspace/.qwen/worktrees/session-1/apps',
      getSessionArtifactProjectRoot: () => '/workspace/apps',
      getActiveSessionTranscriptPath(): string {
        return getSessionTranscriptPath(
          this.getSessionArtifactProjectRoot(),
          this.getSessionId(),
        );
      },
      getSessionId: () => 'session-1',
      getTargetDir: () => '/workspace/.qwen/worktrees/session-1/apps',
    },
    toolRegistry: {
      getTool: vi.fn(() => undefined),
    },
  } as unknown as AgentLoopContext;
}

describe('runLocalAgentInvocation transcript recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts the agent without resume messages when persisted history is unavailable', async () => {
    vi.mocked(readSubagentTranscript).mockResolvedValueOnce(null);

    await expect(
      runLocalAgentInvocation({
        definition: definition(),
        context: context(),
        agentArgs: { query: 'continue inspection' },
        signal: new AbortController().signal,
        description: 'Continue repository inspection',
        modelOverride: 'auto',
        parentModel: 'ultimate',
        agentId: 'agent-1',
        resumeFromTranscript: true,
        registerTask: false,
      }),
    ).resolves.toMatchObject({ terminateReason: AgentTerminateMode.GOAL });

    expect(readSubagentTranscript).toHaveBeenCalledWith(
      {
        sessionTranscriptPath: getSessionTranscriptPath(
          '/workspace/project',
          'session-1',
        ),
      },
      'session-1',
      'agent-1',
    );
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        modelOverride: 'auto',
        parentModel: 'ultimate',
        resolvedModel: 'auto',
        resumeState: undefined,
      }),
    );
    expect(resolveAgentModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'Explore' }),
      'auto',
      'ultimate',
    );
  });

  it('stores and restores session artifacts from the source project in a worktree', async () => {
    vi.mocked(readSubagentTranscript).mockResolvedValueOnce(null);

    await runLocalAgentInvocation({
      definition: definition(),
      context: worktreeContext(),
      agentArgs: { query: 'continue inspection' },
      signal: new AbortController().signal,
      description: 'Continue repository inspection',
      agentId: 'agent-1',
      resumeFromTranscript: true,
      registerTask: false,
    });

    expect(getSubagentTranscriptPath).toHaveBeenCalledWith(
      {
        sessionTranscriptPath: getSessionTranscriptPath(
          '/workspace/apps',
          'session-1',
        ),
      },
      'session-1',
      'agent-1',
    );
    expect(readSubagentTranscript).toHaveBeenCalledWith(
      {
        sessionTranscriptPath: getSessionTranscriptPath(
          '/workspace/apps',
          'session-1',
        ),
      },
      'session-1',
      'agent-1',
    );
    expect(registerAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: {
          sessionTranscriptPath: getSessionTranscriptPath(
            '/workspace/apps',
            'session-1',
          ),
        },
        sessionId: 'session-1',
        agentId: 'agent-1',
      }),
    );
  });

  it('does not register an Agent session task when sessions are disabled', async () => {
    vi.stubEnv(ENV_ENABLE_AGENT_SESSIONS, '0');
    const taskRegistry = {
      register: vi.fn(),
      updateProgress: vi.fn(),
      update: vi.fn(),
    };
    const loopContext = context(
      taskRegistry as unknown as AgentLoopContext['taskRegistry'],
    );

    await runLocalAgentInvocation({
      definition: definition(),
      context: loopContext,
      agentArgs: { query: 'inspect repository' },
      signal: new AbortController().signal,
      description: 'Inspect repository',
      agentId: 'agent-1',
      registerTask: true,
    });

    expect(taskRegistry.register).not.toHaveBeenCalled();
  });

  it('registers the persisted output path so live history can stay bounded', async () => {
    const taskRegistry = new TaskRegistry();
    const testContext = context(taskRegistry);

    await runLocalAgentInvocation({
      definition: definition(),
      context: testContext,
      agentArgs: { query: 'inspect repository' },
      signal: new AbortController().signal,
      description: 'Inspect repository',
      agentId: 'agent-1',
      registerTask: true,
    });

    expect(taskRegistry.get('a-agent-1')).toMatchObject({
      outputPath: '/tmp/task-output',
    });
  });
});
