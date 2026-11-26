/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { branchCommand } from './branchCommand.js';
import type { CommandContext } from './types.js';
import { testListedModel } from '../../../../core/src/test-utils/listed-model.js';

const {
  captureActiveSessionSnapshotMock,
  createForkMock,
  deleteForkArtifactsMock,
  generateUniqueBranchTitleMock,
} = vi.hoisted(() => ({
  captureActiveSessionSnapshotMock: vi.fn(),
  createForkMock: vi.fn(),
  deleteForkArtifactsMock: vi.fn(),
  generateUniqueBranchTitleMock: vi.fn(),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    ForkSessionService: class {
      captureActiveSessionSnapshot = captureActiveSessionSnapshotMock;
      createFork = createForkMock;
      deleteForkArtifacts = deleteForkArtifactsMock;
      generateUniqueBranchTitle = generateUniqueBranchTitleMock;
    },
  };
});

describe('branchCommand', () => {
  it('keeps session-branch navigation input out of the transcript', () => {
    expect(branchCommand.omitInputFromTranscript).toBe(true);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    captureActiveSessionSnapshotMock.mockResolvedValue({
      transcriptChain: [],
      customTitle: 'Current Session',
      directories: ['/tmp/project'],
      fileHistorySnapshots: [],
      runtimeConfig: {
        type: 'runtime-config',
        sessionId: 'source-session',
        timestamp: 1,
        model: 'test-model',
        reasoningEffort: 'high',
        contextWindow: 200_000,
        generation: { temperature: 0.2 },
      },
      contentReplacements: [],
    });
    generateUniqueBranchTitleMock.mockResolvedValue('hello (Branch)');
    createForkMock.mockResolvedValue({
      sessionId: 'fork-session',
      sessionPath: '/tmp/fork.jsonl',
      messages: [],
      directories: ['/tmp/project'],
      fileHistorySnapshots: [],
      worktreeSession: null,
      forkedFrom: {
        sessionId: 'source-session',
        messageUuid: 'message-1',
      },
    });
  });

  it('forks a legacy-bucket session and preserves its exact source path for resumed artifacts', async () => {
    const resumeSession = vi.fn().mockResolvedValue(true);
    const context = {
      services: {
        agentContext: {
          config: {
            getSessionId: () => 'source-session',
            getProjectRoot: () => '/tmp/worktree/apps/desktop',
            getSessionArtifactProjectRoot: () => '/tmp/project',
            getActiveSessionTranscriptPath: () =>
              '/tmp/legacy-bucket/source-session.jsonl',
            getTargetDir: () => '/tmp/worktree/apps/desktop',
            getTranscriptStore: () => ({}),
            getWorkspaceContext: () => ({
              getDirectories: () => ['/tmp/worktree/apps/desktop'],
            }),
            getFileHistoryManager: () => ({ getSnapshots: () => [] }),
            getModel: () => 'test-model',
            getModelRequestIdentity: () => 'branch-identity',
            getModelProviderManager: () => ({
              getModel: async () => testListedModel('test-model'),
              getModelConfig: () => ({
                reasoning: { effort: 'high' },
                context: { contextWindow: 200_000 },
                sampling: { temperature: 0.2 },
              }),
            }),
            getCliVersion: () => '1.2.3',
          },
        },
      },
      messages: [
        {
          type: 'user',
          uuid: 'message-1',
          timestamp: '2025-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        },
      ],
      ui: {
        resumeSession,
      },
    } as unknown as CommandContext;

    const result = await branchCommand.action?.(context, '');

    expect(generateUniqueBranchTitleMock).toHaveBeenCalledWith(
      '/tmp/project',
      'Current Session',
      { excludeSessionIds: ['source-session'] },
    );
    expect(captureActiveSessionSnapshotMock).toHaveBeenCalledWith({
      projectRoot: '/tmp/project',
      sourceSessionId: 'source-session',
      sourceSessionPath: '/tmp/legacy-bucket/source-session.jsonl',
      messages: context.messages,
      directories: ['/tmp/worktree/apps/desktop'],
      fileHistorySnapshots: [],
      runtimeConfig: {
        model: 'test-model',
        reasoningEffort: 'high',
        contextWindow: 200_000,
        generation: { temperature: 0.2, reasoning: { effort: 'high' } },
      },
    });
    expect(createForkMock).toHaveBeenCalledWith({
      projectRoot: '/tmp/project',
      sourceSessionId: 'source-session',
      targetSessionId: expect.any(String),
      targetTitle: 'hello (Branch)',
      runtimeSnapshot:
        await captureActiveSessionSnapshotMock.mock.results[0]?.value,
      targetWorktreeSession: null,
    });
    expect(resumeSession).toHaveBeenCalledWith({
      sessionId: 'fork-session',
      sourceSessionId: 'source-session',
      sourceSessionPath: '/tmp/legacy-bucket/source-session.jsonl',
      messages: [],
      directories: ['/tmp/project'],
      fileHistorySnapshots: [],
      sessionPath: '/tmp/fork.jsonl',
      forkTranscriptPath: '/tmp/fork.jsonl',
      transcriptProjectRoot: '/tmp/project',
      worktreeSession: null,
      customTitle: 'hello (Branch)',
    });
    expect(result).toEqual({
      type: 'local_command_result',
      text: 'Branched conversation. You are now in the branch. To resume the original: /resume source-session',
    });
  });

  it('removes the fork transcript when switching to it returns false', async () => {
    const context = {
      services: {
        agentContext: {
          config: {
            getSessionId: () => 'source-session',
            getProjectRoot: () => '/tmp/project',
            getSessionArtifactProjectRoot: () => '/tmp/project',
            getActiveSessionTranscriptPath: () =>
              '/tmp/project/source-session.jsonl',
            getTargetDir: () => '/tmp/project',
            getTranscriptStore: () => ({}),
            getWorkspaceContext: () => ({ getDirectories: () => [] }),
            getFileHistoryManager: () => undefined,
            getModel: () => 'test-model',
            getModelRequestIdentity: () => 'branch-identity',
            getModelProviderManager: () => ({
              getModel: async () => testListedModel('test-model'),
              getModelConfig: () => undefined,
            }),
            getCliVersion: () => '1.2.3',
          },
        },
      },
      messages: [
        {
          type: 'user',
          uuid: 'message-1',
          timestamp: '2025-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        },
      ],
      ui: {
        resumeSession: vi.fn().mockResolvedValue(false),
      },
    } as unknown as CommandContext;

    expect(await branchCommand.action?.(context, '')).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Failed to branch conversation: Failed to resume the branched conversation.',
    });
    expect(deleteForkArtifactsMock).toHaveBeenCalledWith({
      projectRoot: '/tmp/project',
      sessionId: 'fork-session',
      sessionPath: '/tmp/fork.jsonl',
      originalError: expect.objectContaining({
        message: 'Failed to resume the branched conversation.',
      }),
    });

    const cleanupError = new Error('cleanup failed');
    deleteForkArtifactsMock.mockImplementationOnce(async (input) => {
      throw new AggregateError(
        [input.originalError, cleanupError],
        'Failed to remove incomplete fork session "fork-session" after "Failed to resume the branched conversation.": cleanup failed',
      );
    });
    expect(await branchCommand.action?.(context, '')).toEqual({
      type: 'message',
      messageType: 'error',
      content:
        'Failed to branch conversation: Failed to remove incomplete fork session "fork-session" after "Failed to resume the branched conversation.": cleanup failed',
    });
  });

  it('rejects branching when the conversation is empty', async () => {
    const context = {
      services: {
        agentContext: {
          config: {
            getSessionId: () => 'source-session',
            getProjectRoot: () => '/tmp/project',
            getSessionArtifactProjectRoot: () => '/tmp/project',
          },
        },
      },
      messages: [],
      ui: {
        resumeSession: vi.fn(),
      },
    } as unknown as CommandContext;

    expect(await branchCommand.action?.(context, '')).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'No conversation to branch.',
    });
  });
});
