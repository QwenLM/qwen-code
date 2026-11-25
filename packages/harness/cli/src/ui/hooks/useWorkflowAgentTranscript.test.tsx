/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeFakeConfig,
  getSessionTranscriptPath,
  readSubagentTranscript,
  TranscriptRepository,
  type Message,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import { renderHookWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useWorkflowAgentTranscript } from './useWorkflowAgentTranscript.js';
import type { WorkflowAgentView } from '../workflows/workflowPanelSelectors.js';

vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual<typeof import('@qwen-code/core')>(
    '@qwen-code/core',
  );
  return {
    ...actual,
    readSubagentTranscript: vi.fn(),
    TranscriptRepository: vi.fn(),
  };
});

const mockReadSubagentTranscript = vi.mocked(readSubagentTranscript);
const mockTranscriptRepository = vi.mocked(TranscriptRepository);

function createMessage(text: string): Message {
  return {
    type: 'user',
    uuid: `user-${text}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      role: 'user',
      content: text,
    },
  };
}

function createTask(projectRoot: string): WorkflowUnifiedTask {
  return {
    id: 'wf-task',
    type: 'local_workflow',
    status: 'completed',
    description: 'Workflow task',
    startTime: 1,
    endTime: 2,
    notified: true,
    executionId: 1,
    completionBehavior: 'notify',
    workflowRunId: 'wf_test',
    workflowName: 'audit',
    scriptPath: path.join(projectRoot, 'workflow.js'),
    transcriptDir: path.join(projectRoot, '.qwen', 'workflows', 'wf_test'),
    progress: [],
    logs: [],
    agentCount: 1,
    totalTokens: 0,
    totalToolCalls: 0,
    abortController: new AbortController(),
    agentControllers: {},
  };
}

function createAgent(
  overrides: Partial<WorkflowAgentView> = {},
): WorkflowAgentView {
  return {
    id: '1',
    index: 1,
    label: 'Reader',
    state: 'done',
    status: 'done',
    ...overrides,
  };
}

function mockTranscriptMessages(messages: Message[]): void {
  mockTranscriptRepository.mockImplementation(
    () =>
      ({
        resolveSession: vi.fn(async () => ({ messages })),
      }) as unknown as TranscriptRepository,
  );
}

describe('useWorkflowAgentTranscript', () => {
  beforeEach(() => {
    mockReadSubagentTranscript.mockReset();
    mockTranscriptRepository.mockReset();
  });

  it('loads transcriptPath before falling back to agent id', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-hook-'));
    try {
      const message = createMessage('from transcript path');
      mockTranscriptMessages([message]);
      const task = createTask(projectRoot);
      const agent = createAgent({
        agentId: 'agent-1',
        transcriptPath: path.join(projectRoot, 'agent.jsonl'),
      });

      const { result, unmount } = await renderHookWithProviders(
        () => useWorkflowAgentTranscript({ task, agent }),
        {
          config: makeFakeConfig({
            targetDir: projectRoot,
            cwd: projectRoot,
            sessionId: 'session-1',
          }),
        },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.source).toBe('transcriptPath');
      });
      expect(result.current.messages).toEqual([message]);
      expect(mockReadSubagentTranscript).not.toHaveBeenCalled();
      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('loads a legacy agent from the selected parent transcript when its own path is missing', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-hook-'));
    const worktreeCwd = path.join(projectRoot, 'worktree');
    try {
      mkdirSync(worktreeCwd);
      const message = createMessage('from agent id');
      mockReadSubagentTranscript.mockResolvedValue({
        agentId: 'agent-1',
        messages: [message],
        leafUuid: message.uuid,
        metadata: null,
      });
      const task = createTask(projectRoot);
      const agent = createAgent({ agentId: 'agent-1' });

      const config = makeFakeConfig({
        targetDir: worktreeCwd,
        cwd: worktreeCwd,
        sessionId: 'session-1',
      });
      config.setWorktreeSettings({
        name: 'workflow-test',
        path: worktreeCwd,
        worktreeCwd,
        baseSha: 'base-sha',
        originalCwd: projectRoot,
        lifecycle: 'attached',
      });
      config.registerSessionRuntimeBinding({
        refreshRuntimeContext: async () => undefined,
        getTranscriptPath: () =>
          path.join(projectRoot, 'legacy-bucket', 'session-1.jsonl'),
      });

      const { result, unmount } = await renderHookWithProviders(
        () => useWorkflowAgentTranscript({ task, agent }),
        {
          config,
        },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.source).toBe('agentId');
      });
      expect(result.current.messages).toEqual([message]);
      expect(mockReadSubagentTranscript).toHaveBeenCalledWith(
        { sessionTranscriptPath: config.getActiveSessionTranscriptPath() },
        'session-1',
        'agent-1',
      );
      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to the terminal manifest agent index', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-hook-'));
    try {
      const message = createMessage('from manifest agent id');
      mockReadSubagentTranscript.mockResolvedValue({
        agentId: 'manifest-agent',
        messages: [message],
        leafUuid: message.uuid,
        metadata: null,
      });
      const task = createTask(projectRoot);
      mkdirSync(task.transcriptDir, { recursive: true });
      writeFileSync(
        path.join(task.transcriptDir, 'manifest.json'),
        JSON.stringify({
          agents: [{ index: 1, agentId: 'manifest-agent' }],
        }),
      );
      const agent = createAgent();

      const { result, unmount } = await renderHookWithProviders(
        () => useWorkflowAgentTranscript({ task, agent }),
        {
          config: makeFakeConfig({
            targetDir: projectRoot,
            cwd: projectRoot,
            sessionId: 'session-1',
          }),
        },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.source).toBe('manifest');
      });
      expect(result.current.messages).toEqual([message]);
      expect(mockReadSubagentTranscript).toHaveBeenCalledWith(
        { sessionTranscriptPath: getSessionTranscriptPath(projectRoot, 'session-1') },
        'session-1',
        'manifest-agent',
      );
      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty none state when no manifest exists yet', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-hook-'));
    try {
      const task = createTask(projectRoot);
      const agent = createAgent();

      const { result, unmount } = await renderHookWithProviders(
        () => useWorkflowAgentTranscript({ task, agent }),
        {
          config: makeFakeConfig({
            targetDir: projectRoot,
            cwd: projectRoot,
            sessionId: 'session-1',
          }),
        },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.source).toBe('none');
      });
      expect(result.current.messages).toEqual([]);
      expect(result.current.error).toBeUndefined();
      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not reload when task and agent identities change without transcript keys changing', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-hook-'));
    try {
      const message = createMessage('stable transcript');
      mockTranscriptMessages([message]);
      const task = createTask(projectRoot);
      const agent = createAgent({
        transcriptPath: path.join(projectRoot, 'agent.jsonl'),
      });

      const { result, rerender, unmount } = await renderHookWithProviders(
        ({ nextTask, nextAgent }) =>
          useWorkflowAgentTranscript({ task: nextTask, agent: nextAgent }),
        {
          initialProps: { nextTask: task, nextAgent: agent },
          config: makeFakeConfig({
            targetDir: projectRoot,
            cwd: projectRoot,
            sessionId: 'session-1',
          }),
        },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.messages).toEqual([message]);
      });
      expect(mockTranscriptRepository).toHaveBeenCalledTimes(1);

      rerender({
        nextTask: { ...task, progress: [...task.progress] },
        nextAgent: { ...agent, label: 'Reader updated' },
      });

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });
      expect(result.current.messages).toEqual([message]);
      expect(mockTranscriptRepository).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not expose the previous transcript while a new source loads', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-hook-'));
    try {
      const firstMessage = createMessage('first transcript');
      const secondMessage = createMessage('second transcript');
      let resolveSecond:
        | ((value: { messages: Message[] }) => void)
        | undefined;
      mockTranscriptRepository
        .mockImplementationOnce(
          () =>
            ({
              resolveSession: vi.fn(async () => ({ messages: [firstMessage] })),
            }) as unknown as TranscriptRepository,
        )
        .mockImplementationOnce(
          () =>
            ({
              resolveSession: vi.fn(
                () =>
                  new Promise<{ messages: Message[] }>((resolve) => {
                    resolveSecond = resolve;
                  }),
              ),
            }) as unknown as TranscriptRepository,
        );
      const task = createTask(projectRoot);
      const firstAgent = createAgent({
        transcriptPath: path.join(projectRoot, 'first.jsonl'),
      });

      const { result, rerender, unmount } = await renderHookWithProviders(
        ({ agent }) => useWorkflowAgentTranscript({ task, agent }),
        {
          initialProps: { agent: firstAgent },
          config: makeFakeConfig({
            targetDir: projectRoot,
            cwd: projectRoot,
            sessionId: 'session-1',
          }),
        },
      );
      await waitFor(() =>
        expect(result.current.messages).toEqual([firstMessage]),
      );

      rerender({
        agent: createAgent({
          id: '2',
          index: 2,
          transcriptPath: path.join(projectRoot, 'second.jsonl'),
        }),
      });

      expect(result.current.messages).toEqual([]);
      expect(result.current.loading).toBe(true);

      resolveSecond?.({ messages: [secondMessage] });
      await waitFor(() =>
        expect(result.current.messages).toEqual([secondMessage]),
      );
      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns an error state when transcriptPath loading fails', async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'workflow-hook-'));
    try {
      mockTranscriptRepository.mockImplementation(
        () =>
          ({
            resolveSession: vi.fn(async () => {
              throw new Error('bad transcript');
            }),
          }) as unknown as TranscriptRepository,
      );
      const task = createTask(projectRoot);
      const agent = createAgent({
        transcriptPath: path.join(projectRoot, 'broken.jsonl'),
      });

      const { result, unmount } = await renderHookWithProviders(
        () => useWorkflowAgentTranscript({ task, agent }),
        {
          config: makeFakeConfig({
            targetDir: projectRoot,
            cwd: projectRoot,
            sessionId: 'session-1',
          }),
        },
      );

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toContain('bad transcript');
      });
      expect(result.current.messages).toEqual([]);
      expect(result.current.source).toBe('none');
      unmount();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
