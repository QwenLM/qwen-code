/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Text } from 'ink';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderWithProviders } from '../../test-utils/render.js';
import { AgentTranscriptView } from './AgentTranscriptView.js';
import {
  readSubagentTranscript,
  modelMessageToAssistantPayload,
  makeFakeConfig,
  type AgentUnifiedTask,
  type Message,
} from '@qwen-code/core';
import { waitFor } from '../../test-utils/async.js';

vi.mock('ink-spinner', () => ({
  default: () => <Text>◉</Text>,
}));

vi.mock('@qwen-code/core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/core')
  >('@qwen-code/core');
  return {
    ...actual,
    readSubagentTranscript: vi.fn(),
  };
});

const mockReadSubagentTranscript = vi.mocked(readSubagentTranscript);

function createTask(): AgentUnifiedTask {
  return {
    id: 'a-agent-1',
    type: 'local_agent',
    status: 'completed',
    description: 'Search TODOs in root/config/docs',
    startTime: 1,
    endTime: 2,
    notified: true,
    executionId: 100,
    completionBehavior: 'notify',
    agentId: 'agent-1',
    agentName: 'Explore',
    agentType: 'Explore',
    prompt: 'Search TODOs in root/config/docs',
    isBackgrounded: true,
    taskId: 'task-1',
  };
}

function createMessages(): Message[] {
  const timestamp = new Date().toISOString();
  return [
    {
      type: 'user',
      uuid: 'user-1',
      timestamp,
      message: {
        role: 'user',
        content: 'Search TODOs in root/config/docs',
      },
    },
    {
      type: 'assistant',
      uuid: 'assistant-1',
      timestamp,
      message: modelMessageToAssistantPayload({
        messageId: 'msg-1',

        model: 'test-model',
        stopReason: 'tool_use',

        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        },
        blocks: [
          {
            type: 'text',
            text: 'Checking root files.',
          },
          {
            type: 'tool_use',
            id: 'call-grep',
            name: 'Grep',
            input: { pattern: 'TODO', path: '.' },
          },
        ],
      }),
    },
    {
      type: 'user',
      uuid: 'tool-result-1',
      timestamp,
      toolUseResult: {
        files: [
          {
            file: 'README.md',
            line: 1,
            match: 'TODO: clean this up',
          },
        ],
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-grep',
            content: 'README.md:1 TODO: clean this up',
            is_error: false,
          },
        ],
      },
    },
  ];
}

function createTextMessage(uuid: string, text: string): Message {
  const message = createMessages()[1];
  if (message.type !== 'assistant') throw new Error('unreachable');
  return {
    ...message,
    uuid,
    message: {
      ...message.message,
      content: [{ type: 'text', text }],
    },
  };
}

describe('<AgentTranscriptView />', () => {
  beforeEach(() => {
    mockReadSubagentTranscript.mockReset();
  });

  it('renders legacy transcript messages from the selected parent through the shared history display pipeline', async () => {
    mockReadSubagentTranscript.mockResolvedValue({
      agentId: 'agent-1',
      messages: createMessages(),
      leafUuid: 'assistant-1',
      metadata: null,
    });

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'atv-test-'));
    const originalCwd = tmpBase;
    const worktreeCwd = path.join(tmpBase, 'worktree');
    fs.mkdirSync(worktreeCwd, { recursive: true });
    const config = makeFakeConfig({
      targetDir: worktreeCwd,
      cwd: worktreeCwd,
      sessionId: 'test-session-id',
    });
    config.setWorktreeSettings({
      name: 'session-a',
      path: path.join(tmpBase, 'worktrees', 'session-a'),
      worktreeCwd,
      baseSha: 'base-sha',
      originalCwd,
      lifecycle: 'attached',
    });
    const sessionTranscriptPath = path.join(
      tmpBase,
      'legacy',
      'test-session-id.jsonl',
    );
    config.registerSessionRuntimeBinding({
      refreshRuntimeContext: async () => undefined,
      getTranscriptPath: () => sessionTranscriptPath,
    });

    const renderResult = await renderWithProviders(
      <AgentTranscriptView
        task={createTask()}
        terminalWidth={100}
        availableTerminalHeight={undefined}
      />,
      { config },
    );

    await waitFor(() => {
      const output = renderResult.lastFrame();
      expect(output).toContain('Search TODOs in root/config/docs');
      expect(output).toContain('Checking root files.');
      expect(output).toContain("Grep('TODO' within ./)");
      expect(output).not.toContain('Trace');
      expect(output).not.toContain('Esc back to main');
      expect(output).not.toContain('(completed)');
    });

    expect(mockReadSubagentTranscript).toHaveBeenCalledTimes(1);
    expect(mockReadSubagentTranscript).toHaveBeenCalledWith(
      { sessionTranscriptPath },
      'test-session-id',
      'agent-1',
    );
    renderResult.unmount();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('renders a live delegated prompt without its loaded context', async () => {
    mockReadSubagentTranscript.mockResolvedValue(null);
    const messages = createMessages();
    const firstMessage = messages[0];
    if (firstMessage?.type !== 'user') throw new Error('unreachable');

    const renderResult = await renderWithProviders(
      <AgentTranscriptView
        task={{
          ...createTask(),
          status: 'running',
          endTime: undefined,
          liveMessages: [
            {
              ...firstMessage,
              message: {
                ...firstMessage.message,
                content:
                  '<loaded_context>\n<project_context>secret AGENTS content</project_context>\n</loaded_context>\n\nReview this commit for efficiency only.',
              },
            },
            ...messages.slice(1),
          ],
        }}
        terminalWidth={100}
        availableTerminalHeight={undefined}
      />,
    );

    await waitFor(() => {
      const output = renderResult.lastFrame();
      expect(output).toContain('Review this commit for efficiency only.');
      expect(output).not.toContain('loaded_context');
      expect(output).not.toContain('project_context');
      expect(output).not.toContain('secret AGENTS content');
    });

    expect(mockReadSubagentTranscript).toHaveBeenCalledTimes(1);
    renderResult.unmount();
  });

  it('shows a quiet empty state before transcript messages are available', async () => {
    mockReadSubagentTranscript.mockResolvedValue(null);

    const renderResult = await renderWithProviders(
      <AgentTranscriptView
        task={{
          ...createTask(),
          status: 'running',
          progress: {
            isSubagentProgress: true,
            agentName: 'Explore',
            recentActivity: [
              {
                id: 'activity-1',
                type: 'tool_call',
                content: 'Grep',
                status: 'running',
              },
            ],
          },
        }}
        terminalWidth={100}
        availableTerminalHeight={undefined}
      />,
    );

    await waitFor(() => {
      expect(renderResult.lastFrame()).toContain('No transcript messages yet.');
    });

    renderResult.unmount();
  });

  it('does not render the previous task transcript under a new conversation key', async () => {
    mockReadSubagentTranscript.mockResolvedValueOnce({
      agentId: 'agent-1',
      messages: [createTextMessage('assistant-a', 'agent-a-output')],
      leafUuid: 'assistant-a',
      metadata: null,
    });

    let resolveSecond:
      | ((value: Awaited<ReturnType<typeof readSubagentTranscript>>) => void)
      | undefined;
    mockReadSubagentTranscript.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );

    const renderResult = await renderWithProviders(
      <AgentTranscriptView
        task={createTask()}
        terminalWidth={100}
        availableTerminalHeight={undefined}
      />,
    );
    await waitFor(() =>
      expect(renderResult.lastFrame()).toContain('agent-a-output'),
    );

    const secondTask: AgentUnifiedTask = {
      ...createTask(),
      id: 'a-agent-2',
      agentId: 'agent-2',
      status: 'running',
      endTime: undefined,
    };
    renderResult.rerender(
      <AgentTranscriptView
        task={secondTask}
        terminalWidth={100}
        availableTerminalHeight={undefined}
      />,
    );

    await waitFor(() =>
      expect(renderResult.lastFrame()).toContain('Loading transcript...'),
    );
    expect(renderResult.lastFrame()).not.toContain('agent-a-output');

    resolveSecond?.({
      agentId: 'agent-2',
      messages: [createTextMessage('assistant-b', 'agent-b-output')],
      leafUuid: 'assistant-b',
      metadata: null,
    });
    await waitFor(() =>
      expect(renderResult.lastFrame()).toContain('agent-b-output'),
    );
    renderResult.unmount();
  });
});
